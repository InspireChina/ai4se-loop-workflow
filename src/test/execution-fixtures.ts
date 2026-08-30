import { randomUUID } from 'node:crypto';
import { hash, databaseConnection } from '../infrastructure/database';
import type { AgentContextSnapshot } from '../application/agent-context';
import type { ExecutionAttempt } from '../application/executions';
import { laneForAgent } from '../application/task-lanes';
import type { DelegationEnvelope } from '../application/tasks';
import { isActiveAgentConfigurationPromptCandidate } from '../application/agent-configurations';

export class PromptCanaryDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptCanaryDeferredError';
  }
}

const RECOVERABLE = ['output_received', 'verifying', 'applying'] as const;

function delegationKey(delegation: DelegationEnvelope, inputHash: string) {
  return hash(JSON.stringify({
    taskId: delegation.taskId,
    lane: delegation.lane,
    storyIndex: delegation.storyIndex,
    agent: delegation.agent,
    pipeline: delegation.pipeline,
    feedbackBatchId: delegation.feedbackBatchId || null,
    feedbackGroupId: delegation.feedbackGroupId || null,
    analysisIndex: delegation.analysisIndex,
    devIndex: delegation.devIndex,
    testIndex: delegation.testIndex,
    reviewRevision: delegation.reviewRevision,
    inputHash,
  }));
}

function retrySignature(delegation: DelegationEnvelope) {
  const base = {
    taskId: delegation.taskId,
    lane: delegation.lane || laneForAgent(delegation.agent),
    storyIndex: delegation.storyIndex,
    agent: delegation.agent,
    pipeline: delegation.pipeline,
    feedbackId: delegation.feedbackId || null,
    feedbackIds: delegation.feedbackIds || null,
    feedbackBatchId: delegation.feedbackBatchId || null,
    feedbackGroupId: delegation.feedbackGroupId || null,
  };
  if (delegation.lane === 'analysis') return JSON.stringify({
    ...base,
    analysisIndex: delegation.analysisIndex,
    specResolvedIndex: delegation.specResolvedIndex,
    totalStories: delegation.totalStories,
  });
  if (delegation.lane === 'delivery') return JSON.stringify({
    ...base,
    devIndex: delegation.devIndex,
    testIndex: delegation.testIndex,
  });
  return JSON.stringify({
    ...base,
    agileStatus: delegation.agileStatus,
    analysisIndex: delegation.analysisIndex,
    devIndex: delegation.devIndex,
    testIndex: delegation.testIndex,
    totalStories: delegation.totalStories,
    reviewRevision: delegation.reviewRevision,
  });
}

function storedRetrySignature(attempt: ExecutionAttempt) {
  try {
    const snapshot = JSON.parse(attempt.input_json) as { delegation?: DelegationEnvelope };
    return snapshot.delegation ? retrySignature(snapshot.delegation) : null;
  } catch {
    return null;
  }
}

/** Creates legacy execution snapshots for domain tests. Runtime dispatch must use ProgressDispatcher. */
export async function beginTestExecutionAttempt(input: {
  runId: string;
  delegation: DelegationEnvelope;
  prompt: string;
  baseCommit?: string;
  promptVersion?: number;
  promptTemplateVersion?: number;
  promptHash?: string;
  memoryRevision?: number;
  memoryHash?: string;
  evolutionCandidateId?: string | null;
  executorId?: string;
  configuredModel?: string;
  reasoningEffort?: string;
  webSearchEnabled?: boolean;
  contextSnapshot?: AgentContextSnapshot;
}) {
  const db = await databaseConnection();
  const inputJson = JSON.stringify({
    delegation: input.delegation,
    prompt: input.prompt,
    contextSnapshot: input.contextSnapshot,
    runtime: {
      executorId: input.executorId,
      configuredModel: input.configuredModel,
      reasoningEffort: input.reasoningEffort,
      webSearchEnabled: Boolean(input.webSearchEnabled),
    },
  });
  const inputHash = hash(inputJson);
  return db.transaction(() => {
    let key = delegationKey(input.delegation, inputHash);
    let previous = db.prepare(`
      SELECT * FROM execution_attempts
      WHERE delegation_key = ?
      ORDER BY attempt DESC LIMIT 1
    `).get(key) as ExecutionAttempt | undefined;
    const latestLogical = db.prepare(`
      SELECT * FROM execution_attempts
      WHERE task_id = ? AND story_index IS ? AND agent = ? AND pipeline = ?
        AND COALESCE(lane, CASE
          WHEN agent = 'analyst-agent' THEN 'analysis'
          WHEN agent IN ('dev-agent', 'test-agent') THEN 'delivery'
          ELSE 'control'
        END) = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(
      input.delegation.taskId,
      input.delegation.storyIndex,
      input.delegation.agent,
      input.delegation.pipeline,
      input.delegation.lane || laneForAgent(input.delegation.agent),
    ) as ExecutionAttempt | undefined;
    if (latestLogical?.status === 'retryable_failed' && storedRetrySignature(latestLogical) === retrySignature(input.delegation)) {
      key = latestLogical.delegation_key;
      previous = latestLogical;
    }
    if (previous && RECOVERABLE.includes(previous.status as typeof RECOVERABLE[number])) {
      return { attempt: previous, recovered: true };
    }
    if (previous?.status === 'applied') return { attempt: previous, recovered: true };

    if (input.evolutionCandidateId) {
      if (!isActiveAgentConfigurationPromptCandidate(input.delegation.agent, input.evolutionCandidateId)) {
        throw new PromptCanaryDeferredError('Prompt Canary 已结束，等待使用当前 Prompt 重新派发');
      }
      const active = db.prepare(`
        SELECT execution_id FROM execution_attempts
        WHERE evolution_candidate_id = ?
          AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
        LIMIT 1
      `).get(input.evolutionCandidateId) as { execution_id: string } | undefined;
      if (active) {
        throw new PromptCanaryDeferredError(`Prompt Canary 正由 execution ${active.execution_id} 验证，当前 Agent 稍后重试`);
      }
    }

    const attemptNumber = (previous?.attempt || 0) + 1;
    const executionId = randomUUID();
    db.prepare(`
      INSERT INTO execution_attempts(
        execution_id, run_id, task_id, story_index, agent, pipeline, lane,
        delegation_key, attempt, status, input_hash, input_json, base_commit,
        prompt_version, prompt_template_version, prompt_hash, memory_revision, memory_hash, evolution_candidate_id,
        executor_id, configured_model, reasoning_effort, web_search_enabled,
        heartbeat_at, started_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      executionId,
      input.runId,
      input.delegation.taskId,
      input.delegation.storyIndex,
      input.delegation.agent,
      input.delegation.pipeline,
      input.delegation.lane || laneForAgent(input.delegation.agent),
      key,
      attemptNumber,
      inputHash,
      inputJson,
      input.baseCommit || null,
      input.promptVersion || null,
      input.promptTemplateVersion ?? null,
      input.promptHash || null,
      input.memoryRevision || null,
      input.memoryHash || null,
      input.evolutionCandidateId || null,
      input.executorId || null,
      input.configuredModel || null,
      input.reasoningEffort || null,
      input.webSearchEnabled ? 1 : 0,
    );
    const attempt = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId) as ExecutionAttempt;
    return { attempt, recovered: false };
  }).immediate();
}
