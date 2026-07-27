import { NextResponse } from 'next/server';
import { agentExecutionOptions, getAgentExecutorSettings } from '../../../../../src/application/project-settings';
import { beginTaskContextChatTurn, completeTaskContextChatTurn, failTaskContextChatTurn, getTaskContextChat } from '../../../../../src/application/task-context-chat';
import { runTaskContextChatTurn } from '../../../../../src/infrastructure/task-context-chat-executor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  return NextResponse.json(await getTaskContextChat(taskId));
}

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  let claimed: Awaited<ReturnType<typeof beginTaskContextChatTurn>> | null = null;
  try {
    const body = await request.json() as { message?: unknown };
    const settings = await getAgentExecutorSettings();
    claimed = await beginTaskContextChatTurn(taskId, body.message, settings.executorId);
    const result = await runTaskContextChatTurn({
      taskId,
      sessionId: claimed.session.sessionId,
      messageId: claimed.messageId,
      executor: claimed.session.executor,
      providerSessionId: claimed.session.providerSessionId,
      message: claimed.message,
      commandToken: claimed.commandToken,
      executionOptions: agentExecutionOptions({ ...settings, executorId: claimed.session.executor }),
    });
    const completed = await completeTaskContextChatTurn({
      sessionId: claimed.session.sessionId,
      content: result.answer,
      providerSessionId: result.providerSessionId,
      userMessageId: claimed.messageId,
    });
    const { changeRequestSubmitted, changeRequestCount, ...message } = completed;
    return NextResponse.json({
      message,
      executor: claimed.session.executor,
      mode: 'forward-feedback',
      changeRequestSubmitted,
      changeRequestCount,
    });
  } catch (error) {
    if (claimed) await failTaskContextChatTurn(claimed.session.sessionId, error);
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: detail }, { status: 400 });
  }
}
