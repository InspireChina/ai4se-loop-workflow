import { readFile } from 'node:fs/promises';
import { getRunStatus, loopRunLogPath } from '../../../../src/application/tasks';
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
      let offset = 0;
      const sendNewContent = async () => {
        let content = '';
        try {
          content = await readFile(loopRunLogPath(leaseId), 'utf8');
        } catch {
          return;
        }
        if (content.length <= offset) return;
        const chunk = content.slice(offset);
        controller.enqueue(eventData({ raw: chunk, events: parseRunLog(chunk) }));
        offset = content.length;
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
