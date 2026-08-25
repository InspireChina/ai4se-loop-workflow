import { NextResponse } from 'next/server';
import { agentExecutionOptions, getAgentExecutorSettings } from '../../../../../src/application/project-settings';
import { beginTaskContextChatTurn, completeTaskContextChatTurn, getTaskContextChat, recordTaskContextChatFailureAttempt } from '../../../../../src/application/task-context-chat';
import { EXECUTION_FAILURE_MAX_RETRIES } from '../../../../../src/application/executions';
import { waitForExecutionRetryBackoff, type ExecutionRecoveryMode } from '../../../../../src/application/execution-retry-policy';
import { sanitizeDiagnosticText } from '../../../../../src/infrastructure/diagnostic-text';
import { runTaskContextChatTurn } from '../../../../../src/infrastructure/task-context-chat-executor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  return NextResponse.json(await getTaskContextChat(taskId));
}

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
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
        let claimed: Awaited<ReturnType<typeof beginTaskContextChatTurn>> | null = null;
        try {
          const body = await request.json() as { message?: unknown };
          const settings = await getAgentExecutorSettings();
          claimed = await beginTaskContextChatTurn(taskId, body.message, settings.executorId);
          const claimedMessageId = claimed.messageId;
          send({ type: 'accepted', executor: claimed.session.executor });
          let providerSessionId = claimed.session.providerSessionId;
          let recoveryMode: ExecutionRecoveryMode = 'initial';
          let retryNumber = 0;
          let recoveryMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
          for (let failureAttempt = 1; failureAttempt <= EXECUTION_FAILURE_MAX_RETRIES + 1; failureAttempt += 1) {
            try {
              const result = await runTaskContextChatTurn({
                taskId,
                sessionId: claimed.session.sessionId,
                messageId: claimed.messageId,
                executor: claimed.session.executor,
                providerSessionId,
                message: claimed.message,
                commandToken: claimed.commandToken,
                executionOptions: agentExecutionOptions({ ...settings, executorId: claimed.session.executor }),
                recoveryMode,
                retryNumber,
                maxRetries: EXECUTION_FAILURE_MAX_RETRIES,
                recoveryMessages,
                onProgress: (event) => send({ type: 'progress', event }),
              });
              const completed = await completeTaskContextChatTurn({
                sessionId: claimed.session.sessionId,
                content: result.answer,
                providerSessionId: result.providerSessionId,
                userMessageId: claimed.messageId,
              });
              const { changeRequestSubmitted, changeRequestCount, ...message } = completed;
              send({
                type: 'result',
                message,
                executor: claimed.session.executor,
                mode: 'forward-feedback',
                changeRequestSubmitted,
                changeRequestCount,
              });
              finish();
              return;
            } catch (error) {
              const retry = await recordTaskContextChatFailureAttempt({
                sessionId: claimed.session.sessionId,
                error,
                failureAttempt,
                maxRetries: EXECUTION_FAILURE_MAX_RETRIES,
              });
              if (!retry.willRetry) throw error;
              providerSessionId = null;
              recoveryMode = retry.recovery?.mode || 'minimal';
              retryNumber = retry.failureAttempt;
              const transcript = await getTaskContextChat(taskId);
              recoveryMessages = transcript.messages
                .filter((message) => message.messageId !== claimedMessageId)
                .map((message) => ({ role: message.role, content: message.content }));
              send({
                type: 'progress',
                event: {
                  kind: 'status',
                  label: `自动重试 ${failureAttempt}/${retry.maxRetries} · ${retry.recovery?.label || '恢复包'}`,
                  detail: `${sanitizeDiagnosticText(retry.reason, 760)} · 将使用全新 Provider 会话`,
                  status: 'error',
                },
              });
              await waitForExecutionRetryBackoff(failureAttempt, request.signal);
            }
          }
          throw new Error('上下文 Agent 重试状态异常');
        } catch (error) {
          send({ type: 'error', error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 4_000) });
          finish();
        }
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
