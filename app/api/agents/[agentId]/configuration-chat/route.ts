import { buildAgentConfigurationChatPrompt, validateAgentConfigurationChatOutput } from '../../../../../src/application/agent-configuration-chat';
import { agentExecutionOptions, getAgentExecutorSettings } from '../../../../../src/application/project-settings';
import { sanitizeDiagnosticText } from '../../../../../src/infrastructure/diagnostic-text';
import { runSystemAssistancePrompt } from '../../../../../src/infrastructure/system-assistance-executor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
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
          const body = await request.json() as { commandChainId?: unknown; yaml?: unknown; message?: unknown; history?: unknown };
          const commandChainId = String(body.commandChainId || '');
          const yaml = String(body.yaml || '');
          const settings = await getAgentExecutorSettings();
          send({ type: 'accepted' });
          send({ type: 'progress', event: { kind: 'status', label: '分析配置变更', detail: '正在结合当前 YAML 与编辑要求生成最小修改。', status: 'running' } });
          const run = (prompt: string) => runSystemAssistancePrompt({
            executorId: settings.executorId,
            executionOptions: agentExecutionOptions(settings),
            prompt,
            onProgress: (event) => send({ type: 'progress', event }),
          });
          let output = await run(buildAgentConfigurationChatPrompt({ agentId, commandChainId, yaml, message: body.message, history: body.history }));
          send({ type: 'progress', event: { kind: 'status', label: 'Harness 校验', detail: '正在校验完整 YAML、内置阶段和命令链约束。', status: 'running' } });
          let result;
          try { result = validateAgentConfigurationChatOutput(commandChainId, output); }
          catch (error) {
            const repairError = error instanceof Error ? error.message : String(error);
            send({ type: 'progress', event: { kind: 'status', label: '自动修正草稿', detail: sanitizeDiagnosticText(repairError, 760), status: 'running' } });
            output = await run(buildAgentConfigurationChatPrompt({
              agentId, commandChainId, yaml, message: body.message, history: body.history,
              repairError, invalidOutput: output,
            }));
            result = validateAgentConfigurationChatOutput(commandChainId, output);
          }
          send({ type: 'progress', event: { kind: 'status', label: 'Harness 校验完成', detail: '草稿可以进入人工检查与保存。', status: 'completed' } });
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
