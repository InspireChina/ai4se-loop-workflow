import { buildAgentConfigurationChatPrompt, validateAgentConfigurationChatOutput } from '../../../../../src/application/agent-configuration-chat';
import { agentExecutionOptions, getAgentExecutorSettings } from '../../../../../src/application/project-settings';
import { sanitizeDiagnosticText } from '../../../../../src/infrastructure/diagnostic-text';
import { runSystemAssistancePrompt } from '../../../../../src/infrastructure/system-assistance-executor';
import { isAllowedLocalRequestOrigin } from '../../../../../src/infrastructure/local-request-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  if (!isAllowedLocalRequestOrigin(request)) return new Response('不允许跨来源调用脚本编辑辅助', { status: 403 });
  const { agentId } = await context.params;
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
        catch { closed = true; }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* client disconnected */ }
      };
      void (async () => {
        try {
          const body = await request.json() as { relativePath?: unknown; content?: unknown; message?: unknown; history?: unknown };
          const relativePath = String(body.relativePath || '');
          const content = String(body.content || '');
          const settings = await getAgentExecutorSettings();
          send({ type: 'accepted' });
          send({ type: 'progress', event: { kind: 'status', label: '分析配置变更', detail: '正在结合当前脚本源码与编辑要求生成修改。', status: 'running' } });
          const run = (prompt: string) => runSystemAssistancePrompt({
            executorId: settings.executorId,
            executionOptions: agentExecutionOptions(settings),
            prompt,
            onProgress: (event) => send({ type: 'progress', event }),
          });
          let output = await run(buildAgentConfigurationChatPrompt({ agentId, relativePath, content, message: body.message, history: body.history }));
          send({ type: 'progress', event: { kind: 'status', label: '脚本语法检查', detail: '正在检查完整 JavaScript 源码语法；不会执行草稿。', status: 'running' } });
          let result;
          try { result = validateAgentConfigurationChatOutput(agentId, output); }
          catch (error) {
            const repairError = error instanceof Error ? error.message : String(error);
            send({ type: 'progress', event: { kind: 'status', label: '自动修正草稿', detail: sanitizeDiagnosticText(repairError, 760), status: 'running' } });
            output = await run(buildAgentConfigurationChatPrompt({
              agentId, relativePath, content, message: body.message, history: body.history,
              repairError, invalidOutput: output,
            }));
            result = validateAgentConfigurationChatOutput(agentId, output);
          }
          send({ type: 'progress', event: { kind: 'status', label: '脚本语法检查完成', detail: '源码草稿可以检查并保存到外部文件。', status: 'completed' } });
          send({ type: 'result', ...result });
        } catch (error) {
          send({ type: 'error', error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 4_000) });
        } finally { finish(); }
      })();
    },
    cancel() { closed = true; },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
