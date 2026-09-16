import { applyEvolutionResult, beginEvolutionRun, cancelEvolutionRun, recordEvolutionFailureAttempt, type EvolutionEvidence } from "./agent-evolution";
import { EXECUTION_FAILURE_MAX_RETRIES, executionRecoveryModeForAttempt, executionRecoveryModeLabel, waitForExecutionRetryBackoff } from "./execution-retry-policy";
import { boundedRecoveryText } from "./delegation-prompt";
import { issueInternalAgentCommandToken, readInternalAgentCommandSubmission } from "./internal-agent-command-drafts";
import { appendLoopRunLog } from "./loop-run-log";
import { getLangfuseRuntimeEnv } from "./project-settings";
import { agentLabel } from "../domain/terminology";
import { createLangfuseTelemetry } from "../infrastructure/langfuse";
import { executeDelegation } from "../infrastructure/delegation-execution";
import { paths } from "../infrastructure/database";
import type { AgentExecutor, AgentExecutionOptions } from "../infrastructure/agent-executor";
export async function runEvolutionEvaluator(
  runId: string,
  cancellationSignal: AbortSignal,
  evidence: EvolutionEvidence,
  executor: AgentExecutor,
  executionOptions: AgentExecutionOptions,
) {
  const evolution = await beginEvolutionRun(evidence);
  if (!evolution?.prompt || !evolution.evaluatorDirectory) return;
  for (let failureAttempt = 1;failureAttempt <= EXECUTION_FAILURE_MAX_RETRIES + 1;failureAttempt += 1) {
    try {
      const recoveryMode = executionRecoveryModeForAttempt(failureAttempt);
      const recoveryPrompt = recoveryMode === 'initial' ? evolution.prompt : [
        `# Error Recovery · retry ${failureAttempt - 1}/${EXECUTION_FAILURE_MAX_RETRIES} · ${executionRecoveryModeLabel(recoveryMode)}`,
        '这是错误退出后的全新 CLI / Provider 会话。只从持久化 Evolution 草稿继续，先读取当前 status，避免重复已经提交的观察。',
        '',
        recoveryMode === 'compact'
          ? boundedRecoveryText(evolution.prompt, 12_000)
          : recoveryMode === 'minimal'
            ? boundedRecoveryText(evolution.prompt, 6_000)
            : evolution.prompt,
      ].join('\n');
      const command = await issueInternalAgentCommandToken('evolution', evolution.evolutionId);
      await appendLoopRunLog(runId, `[演化] 开始总结 ${agentLabel(evidence.agentId)} execution=${evidence.executionId} recovery=${recoveryMode}`);
      const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
      const execution = await executeDelegation({
        runId,
        prompt: recoveryPrompt,
        workspaceRoot: evolution.evaluatorDirectory,
        executor,
        executionOptions,
        context: { agent: 'prompt-evolution-agent', taskId: evidence.taskId, storyIndex: evidence.storyIndex, pipeline: 'evolution' },
        description: `总结 ${evidence.agentId} 的可复用经验`,
        telemetry,
        appendLog: (message) => appendLoopRunLog(runId, message),
        maxRuntimeMs: Number(process.env.EVOLUTION_EVALUATOR_TIMEOUT_MS || 5 * 60 * 1000),
        startupTimeoutMs: Number(process.env.EVOLUTION_EVALUATOR_STARTUP_TIMEOUT_MS || 20 * 60 * 1000),
        idleTimeoutMs: Number(process.env.EVOLUTION_EVALUATOR_IDLE_TIMEOUT_MS || 2 * 60 * 1000),
        environment: {
          LOOP_APP_ROOT: paths.appRoot,
          LOOP_DATA_ROOT: paths.dataRoot,
          LOOP_INTERNAL_WORK_TYPE: 'evolution',
          LOOP_INTERNAL_WORK_ID: evolution.evolutionId,
          LOOP_INTERNAL_SESSION_ID: command.sessionId,
          LOOP_INTERNAL_COMMAND_TOKEN: command.token,
        },
        cancellationSignal: cancellationSignal,
      });
      if (execution.cancelled) {
        await cancelEvolutionRun(evolution.evolutionId, 'Runner 已停止，取消后台 Evolution Evaluator');
        await appendLoopRunLog(runId, `[演化] Runner 已停止，取消 ${agentLabel(evidence.agentId)} 的后台总结`);
        return;
      }
      const result = await readInternalAgentCommandSubmission('evolution', evolution.evolutionId);
      if (execution.exitCode !== 0 && !result) {
        throw new Error(execution.terminationReason
          ? `Evaluator CLI ${execution.terminationReason}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
          : `Evaluator CLI 退出码 ${execution.exitCode}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`);
      }
      if (!result) throw new Error('Evolution Evaluator 未通过 evolution complete 提交结果');
      await applyEvolutionResult(evolution.evolutionId, evidence, result);
      await appendLoopRunLog(runId, `[演化] ${agentLabel(evidence.agentId)} 产生 ${result.observations.length} 条结构化观察`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const retry = await recordEvolutionFailureAttempt({
        evolutionId: evolution.evolutionId,
        evidence,
        error: reason,
        failureAttempt,
        maxRetries: EXECUTION_FAILURE_MAX_RETRIES,
      });
      await appendLoopRunLog(
        runId,
        retry.willRetry
          ? `[演化] Evaluator 第 ${failureAttempt} 次失败，将自动重试 ${failureAttempt}/${EXECUTION_FAILURE_MAX_RETRIES}：${reason}`
          : `[演化] Evaluator ${EXECUTION_FAILURE_MAX_RETRIES} 次自动重试已耗尽，但不阻塞开发流程：${reason}`,
      );
      if (!retry.willRetry) return;
      await waitForExecutionRetryBackoff(failureAttempt, cancellationSignal);
    }
  }
}
