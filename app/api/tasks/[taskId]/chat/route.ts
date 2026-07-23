import { NextResponse } from 'next/server';
import { agentExecutionOptions, getAgentExecutorSettings } from '../../../../../src/application/project-settings';
import { beginTaskContextChatTurn, completeTaskContextChatTurn, failTaskContextChatTurn, getTaskContextChat } from '../../../../../src/application/task-context-chat';
import { runTaskContextChatTurn } from '../../../../../src/infrastructure/task-context-chat-executor';
import { gitChangedFilesBetween, gitHead } from '../../../../../src/infrastructure/git';
import { paths } from '../../../../../src/infrastructure/database';

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
    const baseHead = claimed.writeAllowed ? gitHead(paths.root) : '';
    const result = await runTaskContextChatTurn({
      taskId,
      executor: claimed.session.executor,
      providerSessionId: claimed.session.providerSessionId,
      message: claimed.message,
      writeAllowed: claimed.writeAllowed,
      executionOptions: agentExecutionOptions({ ...settings, executorId: claimed.session.executor }),
    });
    const currentHead = claimed.writeAllowed ? gitHead(paths.root) : '';
    const message = await completeTaskContextChatTurn({
      sessionId: claimed.session.sessionId,
      content: result.answer,
      providerSessionId: result.providerSessionId,
      taskId,
      commitHash: baseHead && currentHead !== baseHead ? currentHead : null,
      changedFiles: gitChangedFilesBetween(paths.root, baseHead, currentHead),
    });
    return NextResponse.json({ message, executor: claimed.session.executor, mode: claimed.writeAllowed ? 'lightweight-write' : 'read-only' });
  } catch (error) {
    if (claimed) await failTaskContextChatTurn(claimed.session.sessionId, error);
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: detail }, { status: 400 });
  }
}
