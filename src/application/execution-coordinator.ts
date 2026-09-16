import { createHash } from "node:crypto";
import { agentExecutionOptions, getAgentRuntimeSettings } from "./project-settings";
import type { loadAgentRuntime } from "./agent-profiles";
import type { buildAgentContextSnapshot } from "./agent-context";
import { issueAgentCommandToken, readAgentCommandSubmission, resetAgentCommandStatusForContinuation } from "./agent-command-drafts";
import { recordExecutionFailureObservation, updatePromptCanary, type EvolutionEvidence } from "./agent-evolution";
import { applyAgentResult } from "./agent-results";
import {
  cancelExecution, executionCancellationReason, completeExecution, deferExecutionResult, executionCancellationRequested,
  EXECUTION_FAILURE_MAX_RETRIES, failExecutionWithRetryPolicy, markExecutionOutput, markExecutionStage,
  recordExecutionReceipt, recordCleanExitContinuationActivity, type ExecutionAttempt
} from "./executions";
import { coordinateExecutionInvocations } from "./execution-invocation";
import { retryRecoveryPlanForFailure, shouldRetryReportedFailure, type ExecutionRecoveryMode } from "./execution-retry-policy";
import { CodeSlotBusyError, getTask, type DelegationEnvelope } from "./tasks";
import { appendLoopRunLog } from "./loop-run-log";
import { progressDispatcher, type ReservedExecution } from "./progress-dispatch";
import { AgentResultContractError, parseAgentResult } from "../domain/agent-result";
import { agentLabel } from "../domain/terminology";
import { getAgentExecutor, type AgentExecutionOptions, type AgentExecutor } from "../infrastructure/agent-executor";
import type { DelegationExecutionResult } from "../infrastructure/delegation-execution";
import { gitHead } from "../infrastructure/git";
import { collectDevCodeEvidence } from "./dev-code-evidence";
import { readGitExecutionBaseline } from "../infrastructure/git-commit-evidence";

export type PreparedDelegationPrompt = {
  prompt: string;
  runtime: Awaited<ReturnType<typeof loadAgentRuntime>>;
  contextSnapshot: ReturnType<typeof buildAgentContextSnapshot>;
  recovery: { mode: ExecutionRecoveryMode; label: string; retryNumber: number };
};
export type ExecutionCycle = { executionId: string; eventFromId: number | null };
export type ExecutionCoordinatorPorts = {
  runId: string;
  isRunActive: () => Promise<boolean>;
  buildPrompt: (work: DelegationEnvelope, baseCommit: string | null, attempt: number, workspace: string, projectId?: string) => Promise<PreparedDelegationPrompt>;
  invoke: (work: DelegationEnvelope, prompt: string, executionId: string, commandToken: string, executor: AgentExecutor,
    options: AgentExecutionOptions, signal: AbortSignal, workspace: string) => Promise<DelegationExecutionResult & { diagnostics: string[] }>;
  evaluate: (evidence: EvolutionEvidence, executor: AgentExecutor, options: AgentExecutionOptions) => Promise<void>;
  scheduleEvaluation: (evaluation: Promise<void>) => void;
  controllers: Map<string, AbortController>;
  cycleStarted: (attempt: ExecutionAttempt, work: DelegationEnvelope) => Promise<ExecutionCycle>;
  cycleFinished: (cycle: ExecutionCycle, failure?: unknown) => Promise<void>;
};

/** Owns activation, persisted result recovery, invocation, application and settlement.
 * Runner supplies host lifetime and physical invocation ports, not failure policy.
 */
export function createExecutionCoordinator(ports: ExecutionCoordinatorPorts) {
  const { runId, isRunActive, buildPrompt } = ports;
  const runDelegation = ports.invoke;
  const runEvolutionEvaluator = ports.evaluate;
  const scheduleEvolution = ports.scheduleEvaluation;
  const activeExecutionControllers = ports.controllers;
  const recordExecutionCycleStarted = ports.cycleStarted;
  const recordExecutionCycleFinished = ports.cycleFinished;

  async function processDurableResult(attempt: ExecutionAttempt, delegation: DelegationEnvelope, result: ReturnType<typeof parseAgentResult>) {
    let codeCommit = attempt.code_commit || '';
    const current = await getTask(delegation.taskId);
    if (!current || await executionCancellationRequested(attempt.execution_id)) {
      await markExecutionStage(attempt.execution_id, 'applying');
      const outcome = await applyAgentResult(runId, delegation, result, { codeCommit, executionId: attempt.execution_id });
      await recordExecutionReceipt(attempt.execution_id, 'application', outcome, { outcome, terminalTask: true });
      await completeExecution(attempt.execution_id);
      await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 返回时需求已结束或暂停，结果仅保留为证据，不再应用`);
      return { outcome };
    }
    if (delegation.agent === 'dev-agent' && result.outcome === 'completed' && !codeCommit) {
      const evidence = await collectDevCodeEvidence(attempt.execution_id);
      const codeEvidenceKey = createHash('sha256').update(JSON.stringify(evidence)).digest('hex').slice(0, 32);
      await recordExecutionReceipt(attempt.execution_id, 'code_evidence', codeEvidenceKey, evidence);
      if (evidence.kind === 'changed') {
        codeCommit = evidence.commit;
        await recordExecutionReceipt(attempt.execution_id, 'code_commit', codeCommit, {
          taskId: delegation.taskId,
          storyIndex: delegation.storyIndex,
          mode: 'agent_committed',
          baseCommit: evidence.baseCommit,
          changedFiles: evidence.changedFiles,
          evidence: 'owned-execution-git-diff',
        });
        await appendLoopRunLog(runId, `[运行] 记录开发实现 Agent 变更所在 commit：${codeCommit.slice(0, 10)}`);
      } else if (evidence.kind === 'unchanged') {
        await appendLoopRunLog(runId, '[运行] Git 核对执行基线与最终提交无代码差异；不记录新的代码提交证据');
      } else {
        await appendLoopRunLog(runId, `[运行] 开发代码成果暂不能确认：${evidence.reason}；不把已有 HEAD 当作本次成果`);
      }
    }

    await markExecutionStage(attempt.execution_id, 'applying');
    const outcome = await applyAgentResult(runId, delegation, result, { codeCommit, executionId: attempt.execution_id });
    await recordExecutionReceipt(attempt.execution_id, 'application', outcome, { outcome });
    await completeExecution(attempt.execution_id);
    const outcomeLabel = { advanced: '已推进', blocked: '等待澄清', rewound: '已回退', discarded: '已丢弃副作用' }[outcome];
    await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 结构化结果已应用：${outcomeLabel}`);
    return { outcome };
  }

  async function handleExecutionFailure(
    attempt: ExecutionAttempt,
    delegation: DelegationEnvelope,
    reason: string,
    failureKind = 'agent-execution',
  ) {
    const retry = await failExecutionWithRetryPolicy(attempt.execution_id, reason, {
      kind: failureKind,
      maxRetries: EXECUTION_FAILURE_MAX_RETRIES,
    });
    if (retry.ignored) return;
    const willRetry = retry.willRetry;
    try {
      await updatePromptCanary(delegation.agent, false, attempt.execution_id);
      await recordExecutionFailureObservation({ executionId: attempt.execution_id, taskId: delegation.taskId, agentId: delegation.agent, reason });
    } catch (evolutionError) {
      await appendLoopRunLog(runId, `[演化] 失败观察写入失败但不影响主流程：${evolutionError instanceof Error ? evolutionError.message : String(evolutionError)}`);
    }
    if (willRetry) {
      const recovery = retryRecoveryPlanForFailure(retry.failureAttempt);
      await appendLoopRunLog(
        runId,
        `[恢复] ${failureKind} 执行失败，将自动重试 ${retry.failureAttempt}/${retry.maxRetries}${recovery ? `（${recovery.label}）` : ''}：${reason}`,
      );
      return;
    }
    await appendLoopRunLog(runId, `[错误] ${agentLabel(delegation.agent)} ${reason}`);
  }

  async function executeDelegationStep(
    reservation: ReservedExecution,
  ) {
    const delegation = reservation.work;
    if (!(await isRunActive())) {
      await progressDispatcher.settle({ reservationId: reservation.reservationId });
      return;
    }
    const task = await getTask(delegation.taskId);
    if (!task || await executionCancellationRequested(reservation.executionId)) {
      await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} 已取消或暂停，跳过尚未启动的 ${agentLabel(delegation.agent)}`);
      await progressDispatcher.settle({ reservationId: reservation.reservationId });
      return;
    }
    await appendLoopRunLog(runId, `[运行] 执行任务级 Agent：requirement=${delegation.taskId} agent=${delegation.agent}`);

    let attempt: ExecutionAttempt | null = null;
    let cycle: { executionId: string; eventFromId: number | null } | null = null;
    let unexpectedFailure: unknown;
    try {
      const runtimeSettings = await getAgentRuntimeSettings(delegation.agent);
      const executor = getAgentExecutor(runtimeSettings.executorId);
      const executionOptions = agentExecutionOptions(runtimeSettings);
      await appendLoopRunLog(runId, `[Runtime] requirement=${delegation.taskId} agent=${delegation.agent} executor=${executor.id} model=${executionOptions.model || 'default'} reasoning=${executionOptions.reasoningEffort || 'default'} web_search=${executionOptions.webSearch ? 'enabled' : 'disabled'}`);
      const workspaceRoot = task.task.work_dir;
      const codeBaseline = delegation.agent === 'dev-agent' ? await readGitExecutionBaseline(workspaceRoot) : null;
      const headBefore = codeBaseline?.head || gitHead(workspaceRoot);
      const builtPrompt = await buildPrompt(delegation, headBefore || null, reservation.attempt, workspaceRoot, task.task.project_id);
      const activated = await progressDispatcher.activate({
        reservationId: reservation.reservationId,
        prepared: {
          prompt: builtPrompt.prompt,
          baseCommit: headBefore,
          recovery: builtPrompt.recovery,
          promptMetadata: {
            version: builtPrompt.runtime.promptVersion,
            templateVersion: builtPrompt.runtime.promptTemplateVersion,
            hash: builtPrompt.runtime.promptHash,
          },
          memory: {
            revision: builtPrompt.runtime.memoryRevision,
            hash: builtPrompt.runtime.memoryHash,
          },
          evolutionCandidateId: builtPrompt.runtime.evolutionCandidateId,
          contextSnapshot: builtPrompt.contextSnapshot,
          runtime: {
            executorId: runtimeSettings.executorId,
            model: executionOptions.model,
            reasoningEffort: executionOptions.reasoningEffort,
            webSearchEnabled: Boolean(executionOptions.webSearch),
          },
        },
      });
      if (activated.kind === 'invalidated') {
        await appendLoopRunLog(runId, `[调度] requirement=${delegation.taskId} reservation=${reservation.reservationId} 启动前失效：${activated.reason}`);
        return;
      }
      attempt = activated.attempt;
      if (codeBaseline) await recordExecutionReceipt(attempt.execution_id, 'code_baseline', 'execution-start', codeBaseline);
      await appendLoopRunLog(runId, `[上下文] requirement=${delegation.taskId} execution=${attempt.execution_id} snapshot=${builtPrompt.contextSnapshot.snapshotId} resources=${builtPrompt.contextSnapshot.resourceCount} startup_index=${builtPrompt.contextSnapshot.startupIndex.length} recovery=${builtPrompt.recovery.mode}`);
      if (await executionCancellationRequested(attempt.execution_id)) {
        const reason = await executionCancellationReason(attempt.execution_id);
        await cancelExecution(attempt.execution_id, reason);
        await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} execution=${attempt.execution_id} ${reason}，跳过尚未启动的 ${agentLabel(delegation.agent)}，执行资源已释放`);
        return;
      }
      cycle = await recordExecutionCycleStarted(attempt, delegation);

      const commandToken = await issueAgentCommandToken(attempt.execution_id);
      if (!commandToken) {
        throw new Error(`${delegation.agent}/${delegation.pipeline} 无法签发渐进式命令凭证`);
      }
      const executionId = attempt.execution_id;
      const cancellation = new AbortController();
      activeExecutionControllers.set(attempt.execution_id, cancellation);
      let execution: Awaited<ReturnType<typeof runDelegation>>;
      let commandSubmission: Awaited<ReturnType<typeof readAgentCommandSubmission>>;
      try {
        ({ execution, commandSubmission } = await coordinateExecutionInvocations({
          originalPrompt: builtPrompt.prompt,
          executorLabel: executor.label,
          invoke: (prompt) => runDelegation(delegation, prompt, executionId, commandToken, executor, executionOptions, cancellation.signal, workspaceRoot),
          readSubmission: () => readAgentCommandSubmission(executionId),
          resetStatus: () => resetAgentCommandStatusForContinuation(executionId),
          cancellationReason: () => executionCancellationReason(executionId),
          recordActivity: (phase, count, reason) => recordCleanExitContinuationActivity(executionId, phase, count, reason),
          onScheduled: (count, reset) => appendLoopRunLog(runId, `[自动续跑] requirement=${delegation.taskId} execution=${executionId} CLI exit 0 但没有角色终止提交，立即继续同一 execution（第 ${count} 次，不消耗失败重试额度${reset ? '，已要求重新读取 status' : ''}）`),
          onSucceeded: (count) => appendLoopRunLog(runId, `[自动续跑] requirement=${delegation.taskId} execution=${executionId} 经过 ${count} 次续跑后收到角色终止提交`),
        }));
      } finally {
        activeExecutionControllers.delete(attempt.execution_id);
      }
      await progressDispatcher.executionExited({ reservationId: reservation.reservationId });
      if (execution.cancelled || await executionCancellationRequested(attempt.execution_id)) {
        const reason = await executionCancellationReason(attempt.execution_id);
        await cancelExecution(attempt.execution_id, reason);
        await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} execution=${attempt.execution_id} ${agentLabel(delegation.agent)} 已停止：${reason}，执行资源已释放`);
        return;
      }
      if (execution.evidencePersistenceError) {
        await handleExecutionFailure(
          attempt,
          delegation,
          `本地执行证据写入失败，将自动重试：${execution.evidencePersistenceError}`,
          'evidence-persistence',
        );
        return;
      }
      commandSubmission ||= await readAgentCommandSubmission(attempt.execution_id);
      if (execution.exitCode !== 0 && !commandSubmission) {
        const exitDiagnostic = [
          `退出码 ${execution.exitCode}`,
          execution.signal ? `signal ${execution.signal}` : '',
          execution.failureDetail || '',
        ].filter(Boolean).join('；');
        await handleExecutionFailure(
          attempt,
          delegation,
          execution.terminationReason
            ? `${executor.label} CLI ${execution.terminationReason}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
            : `${executor.label} CLI 执行失败，${exitDiagnostic}`,
          execution.terminationKind==='activity-stalled'?'agent-stalled':execution.terminationReason ? 'agent-timeout' : 'agent-cli-exit',
        );
        return;
      }

      let result;
      try {
        if (!commandSubmission) {
          throw new Error('Agent 退出前没有成功执行角色终止命令；普通最终文本不会推进流程');
        }
        result = commandSubmission;
        await appendLoopRunLog(runId, `[Agent 命令] requirement=${delegation.taskId} ${delegation.agent} 已通过领域终止命令提交结果`);
      } catch (error) {
        const reason = `Agent 未通过角色终止命令提交结果：${error instanceof Error ? error.message : String(error)}`;
        await handleExecutionFailure(attempt, delegation, reason, 'agent-missing-terminal-command');
        return;
      }
      if (shouldRetryReportedFailure(result, attempt.attempt, delegation.agent)) {
        const reason = `Agent 提交失败结果，将按统一策略重试：${result.summary || result.outcome || result.verdict || '未提供摘要'}`;
        await handleExecutionFailure(attempt, delegation, reason, 'agent-reported-failure');
        return;
      }
      await markExecutionOutput(attempt.execution_id, result);
      try {
        const applied = await processDurableResult({ ...attempt, result_json: JSON.stringify(result), status: 'output_received' }, delegation, result);
        const succeeded = result.outcome !== 'failed' && result.verdict !== 'failed';
        await updatePromptCanary(delegation.agent, succeeded, attempt.execution_id);
        scheduleEvolution(runEvolutionEvaluator({
          executionId: attempt.execution_id,
          taskId: delegation.taskId,
          projectId: task.task.project_id,
          storyIndex: delegation.storyIndex,
          agentId: delegation.agent,
          attempt: attempt.attempt,
          promptVersion: builtPrompt.runtime.promptVersion,
          result: { outcome: result.outcome, summary: result.summary },
          applicationOutcome: applied.outcome,
          diagnostics: execution.diagnostics,
        }, executor, executionOptions));
      } catch (error) {
        if (error instanceof CodeSlotBusyError) {
          await deferExecutionResult(attempt.execution_id, error.message);
          await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} ${agentLabel(delegation.agent)} 结果已进入队列，等待 ${error.ownerTaskId} 释放代码槽`);
          return;
        }
        const reason = `应用 Agent 结果失败：${error instanceof Error ? error.message : String(error)}`;
        await handleExecutionFailure(
          attempt,
          delegation,
          reason,
          error instanceof AgentResultContractError ? 'agent-result-contract' : 'agent-result-application',
        );
      }
    } catch (error) {
      unexpectedFailure = error;
      const reason = `任务级 Agent 执行异常：${error instanceof Error ? error.message : String(error)}`;
      if (attempt) await handleExecutionFailure(attempt, delegation, reason, 'agent-execution');
      else {
        const preparation = await progressDispatcher.preparationFailed({ reservationId: reservation.reservationId, error: reason });
        await appendLoopRunLog(runId, preparation.kind === 'retry'
          ? `[恢复] requirement=${delegation.taskId} prompt 准备失败，执行第 ${preparation.attempt}/${EXECUTION_FAILURE_MAX_RETRIES} 次重试（${retryRecoveryPlanForFailure(preparation.attempt)?.label || '恢复包'}）：${reason}`
          : `[错误] requirement=${delegation.taskId} agent=${delegation.agent} ${reason}`);
      }
    } finally {
      await progressDispatcher.executionExited({ reservationId: reservation.reservationId });
      await progressDispatcher.settle({ reservationId: reservation.reservationId });
      if (cycle) await recordExecutionCycleFinished(cycle, unexpectedFailure);
    }
  }

  async function recover(recoverable: ExecutionAttempt, delegation: DelegationEnvelope) {
    const cycle = await recordExecutionCycleStarted(recoverable, delegation);
    try {
      const runtimeSettings = await getAgentRuntimeSettings(delegation.agent);
      const executor = getAgentExecutor(runtimeSettings.executorId);
      const executionOptions = agentExecutionOptions(runtimeSettings);
      await appendLoopRunLog(runId, `[恢复] 继续 execution attempt ${recoverable.execution_id}，不重复调用 Agent`);
      const result = parseAgentResult(recoverable.result_json || '');
      const applied = await processDurableResult(recoverable, delegation, result);
      const succeeded = result.outcome !== 'failed' && result.verdict !== 'failed';
      await updatePromptCanary(delegation.agent, succeeded, recoverable.execution_id);
      scheduleEvolution(runEvolutionEvaluator({
        executionId: recoverable.execution_id,
        taskId: recoverable.task_id,
        projectId: (await getTask(recoverable.task_id))?.task.project_id,
        storyIndex: recoverable.story_index,
        agentId: recoverable.agent,
        attempt: recoverable.attempt,
        promptVersion: recoverable.prompt_version,
        result: { outcome: result.outcome, summary: result.summary },
        applicationOutcome: applied.outcome,
        diagnostics: [],
      }, executor, executionOptions));
    } catch (error) {
      const reason = `恢复 execution attempt 失败：${error instanceof Error ? error.message : String(error)}`;
      await handleExecutionFailure(
        recoverable,
        delegation,
        reason,
        error instanceof AgentResultContractError ? 'agent-result-contract' : 'agent-result-application',
      );
    } finally {
      await progressDispatcher.settleRecoveredExecution({ executionId: recoverable.execution_id });
      await recordExecutionCycleFinished(cycle);
    }
  }
  return { execute: executeDelegationStep, recover };
}
