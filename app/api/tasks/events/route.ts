import {
  subscribeRuntimeEvents,
  type RuntimeEvent,
  type RuntimeEventTopic,
} from '../../../../src/infrastructure/runtime-event-hub';
import { databaseConnection } from '../../../../src/infrastructure/database';
import { runtimeEventRevisionInDb } from '../../../../src/application/runtime-events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const encoder = new TextEncoder();
const KEEP_ALIVE_INTERVAL_MS = 15_000;

function serverSentEvent(name: string, data: unknown) {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: Request) {
  let closeStream = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const topics = ['dispatch.invalidated', 'task.progressed'] as const satisfies readonly RuntimeEventTopic[];
      const lastRevisions = new Map<RuntimeEventTopic, number>();
      const enqueue = (value: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(value);
        } catch {
          closeStream();
        }
      };
      const subscription = subscribeRuntimeEvents({
        topics,
        onReady: async () => {
          const db = await databaseConnection();
          let changed = false;
          const revisions: Partial<Record<RuntimeEventTopic, number>> = {};
          for (const topic of topics) {
            const revision = runtimeEventRevisionInDb(db, topic);
            if (lastRevisions.has(topic) && revision !== lastRevisions.get(topic)) changed = true;
            lastRevisions.set(topic, revision);
            revisions[topic] = revision;
          }
          if (changed) enqueue(serverSentEvent('refresh', { revisions }));
          enqueue(serverSentEvent('ready', { connected: true, revisions }));
        },
        onEvent: (event: RuntimeEvent) => {
          lastRevisions.set(event.topic, Math.max(lastRevisions.get(event.topic) ?? event.revision, event.revision));
          enqueue(serverSentEvent('refresh', {
            topic: event.topic,
            revision: event.revision,
            entityId: event.entityId,
          }));
        },
      });
      const keepAlive = setInterval(() => enqueue(encoder.encode(': keep-alive\n\n')), KEEP_ALIVE_INTERVAL_MS);
      keepAlive.unref();

      closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        subscription.close();
        request.signal.removeEventListener('abort', closeStream);
        try {
          controller.close();
        } catch {
          // The browser may already have closed the stream.
        }
      };
      request.signal.addEventListener('abort', closeStream, { once: true });
      enqueue(encoder.encode('retry: 1000\n\n'));
    },
    cancel() {
      closeStream();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
