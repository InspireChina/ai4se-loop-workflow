import { buildCleanExitContinuationPrompt, shouldContinueAfterCleanExit } from './terminal-command-recovery';

export type InvocationObservation = {
  exitCode: number;
  cancelled?: boolean;
  diagnostics: string[];
  stderrTail?: string;
  failureDetail?: string;
  finalText: string;
  evidencePersistenceError?: string | null;
  terminationReason?: string | null;
};

export type ContinuationActivity = 'scheduled' | 'failed' | 'succeeded' | 'stopped';

/** Coordinates one execution's physical invocations, not its workflow result.
 * Ports own persistence and execution identity; no Runner, UI, or scheduler is required.
 * Clean exit continuation preserves the existing policy during structural migration.
 */
export async function coordinateExecutionInvocations<T extends InvocationObservation, S>(input: {
  originalPrompt: string;
  executorLabel: string;
  invoke: (prompt: string) => Promise<T>;
  readSubmission: () => Promise<S | null>;
  resetStatus: () => Promise<boolean>;
  cancellationReason: () => Promise<string>;
  recordActivity: (phase: ContinuationActivity, count: number, reason?: string) => Promise<void>;
  onScheduled: (count: number, statusReset: boolean) => Promise<void>;
  onSucceeded: (count: number) => Promise<void>;
}) {
  let prompt = input.originalPrompt;
  let count = 0;
  let diagnostics: string[] = [];
  let previousStderrTail: string | undefined;
  let previousFailureDetail: string | undefined;
  let execution: T;
  let submission: S | null;
  while (true) {
    let current: T;
    try {
      current = await input.invoke(prompt);
    } catch (error) {
      if (count > 0) await input.recordActivity('failed', count, error instanceof Error ? error.message : String(error));
      throw error;
    }
    diagnostics = [...diagnostics, ...current.diagnostics];
    execution = {
      ...current, diagnostics,
      stderrTail: current.stderrTail || previousStderrTail,
      failureDetail: current.failureDetail || previousFailureDetail,
    };
    previousStderrTail = execution.stderrTail;
    previousFailureDetail = execution.failureDetail;
    submission = await input.readSubmission();
    if (!shouldContinueAfterCleanExit({
      exitCode: execution.exitCode,
      hasSubmission: Boolean(submission),
      cancelled: Boolean(execution.cancelled),
      evidencePersistenceError: execution.evidencePersistenceError,
    })) break;
    count += 1;
    await input.recordActivity('scheduled', count);
    try {
      const statusReset = await input.resetStatus();
      await input.onScheduled(count, statusReset);
      prompt = buildCleanExitContinuationPrompt({
        originalPrompt: input.originalPrompt,
        previousFinalText: execution.finalText,
        continuationNumber: count,
      });
    } catch (error) {
      await input.recordActivity('failed', count, `准备续跑失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  if (count > 0) {
    if (submission) {
      await input.recordActivity('succeeded', count);
      await input.onSucceeded(count);
    } else if (execution.cancelled) {
      await input.recordActivity('stopped', count, await input.cancellationReason());
    } else {
      const reason = execution.evidencePersistenceError
        ? `本地执行证据写入失败：${execution.evidencePersistenceError}`
        : execution.terminationReason
          ? `${input.executorLabel} CLI ${execution.terminationReason}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
          : `CLI 退出码 ${execution.exitCode}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`;
      await input.recordActivity('failed', count, reason);
    }
  }
  return { execution, commandSubmission: submission, continuationCount: count };
}
