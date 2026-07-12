import { getRunStatus, readLoopRunLogChunk } from '../../../../src/application/tasks';
import { parseRunLog } from '../../../../src/application/run-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const encoder = new TextEncoder();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventData(data: unknown) {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function doneEvent() {
  return encoder.encode('event: done\ndata: "done"\n\n');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const leaseId = searchParams.get('leaseId') || '';
  const stream = new ReadableStream({
    async start(controller) {
      let afterId = 0;
      const sendNewContent = async () => {
        let chunk = { raw: '', lastId: afterId };
        try {
          chunk = await readLoopRunLogChunk(leaseId, afterId);
        } catch {
          return;
        }
        if (!chunk.raw) return;
        controller.enqueue(eventData({ raw: chunk.raw, events: parseRunLog(chunk.raw) }));
        afterId = chunk.lastId;
      };

      while (!request.signal.aborted) {
        const run = await getRunStatus();
        if (!run?.active || run.leaseId !== leaseId) {
          await sendNewContent();
          controller.enqueue(doneEvent());
          controller.close();
          return;
        }
        await sendNewContent();
        await sleep(1000);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
