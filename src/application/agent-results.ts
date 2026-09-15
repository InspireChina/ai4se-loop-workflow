import { randomUUID } from 'node:crypto';
import { parseAgentResult, assertAgentResultRoleContract, type AgentResult } from '../domain/agent-result';
import type { Actor } from '../domain/task';
import { resourcesForAgent } from '../domain/resource';
import { databaseConnection } from '../infrastructure/database';
import { laneForAgent, settleTaskLaneInDb, setTaskLaneStateInDb } from './task-lanes';
import {
  CODE_WORKSPACE_RESOURCE,
  acquireResourceClaimInDb,
  activeResourceClaimInDb,
  releaseResourceClaimInDb,
  releaseExecutionResourceClaimsInDb,
  releaseLaneExecutionResourceClaimsInDb,
} from './resource-claims';
import {
  createOrReopenRecoveryItem,
  recordRecoveryClaims,
  resolveActiveRecoveryItems,
} from './recovery-items';
import {
  addQuestion,
  addPlannedDeliveryUnits,
  addRuntimeInputRequest,
  CodeSlotBusyError,
  getTask,
  rewindTask,
  resolveBusinessAnalysisSpecificationComments,
  resolveRuntimeInputs,
  saveDeliverySpec,
  setTaskLaneState,
  updateTask,
  upsertDocument,
  type DelegationEnvelope,
} from './tasks';
import {
  applyFeedbackReproResult,
  applyFeedbackSplitResult,
  applyFeedbackTriageGroups,
  applyFeedbackVerificationV2,
  markFeedbackBatchWaitingForAnswers,
  recordFeedbackUnitTestPassed,
} from './feedback';
import { forwardReviewClosureGaps } from './review-closure-gaps';
import { publishReviewReport } from './review-report-publication';
import { EXECUTION_FAILURE_MAX_RETRIES, failExecutionWithRetryPolicy } from './executions';
import { observeWorkflowFailureInDb } from './workflow-failures';
import { openInterventionInDb } from './interventions';
import { rewindWorkItemsInDb, transitionWorkItemInDb } from './work-item-transitions';
import { restoreExecutionDelegationInDb } from './execution-delegation';
import type { WorkflowItemRow } from './work-items';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';
import { finalizeTaskAfterFeedbackInDb } from './feedback';
import { workflowResultHeldInDb, workflowEndedInDb } from './work-item-controls';
import { finalDocumentSnapshotInDb } from './work-item-artifacts';

const artifactKinds: Record<string, string> = {
  'direct-agent': 'direct_result',
  'idea-context-agent': 'ba_intent',
  'business-design-agent': 'ba_solution',
  'requirement-spec-agent': 'ba_spec',
  'spec-review-agent': 'ba_review',
  'backlog-agent': 'context',
  'story-splitter-agent': 'delivery_split',
  'analyst-agent': 'analysis',
  'repro-agent': 'repro',
  'dev-agent': 'dev_note',
  'test-agent': 'test_result',
  'review-agent': 'review',
};

function questionKind(agent: string) {
  if (agent === 'analyst-agent') return 'analysis' as const;
  if (agent === 'test-agent') return 'test' as const;
  if (agent === 'feedback-agent') return 'feedback' as const;
  return 'local' as const;
}

async function saveArtifact(delegation: DelegationEnvelope, result: AgentResult) {
  let artifact = result.artifact;
  if (!artifact && delegation.agent === 'backlog-agent') artifact = {
    title: '业务变化上下文',
    content: result.summary,
  };
  if (!artifact && delegation.agent === 'story-splitter-agent' && result.deliveryUnits?.length) artifact = {
    title: '交付单元拆分',
    content: result.deliveryUnits.map((unit, index) => `${index + 1}. ${unit.title}`).join('\n'),
  };
  if (!artifact && delegation.agent === 'dev-agent') artifact = {
    title: `交付单元 ${delegation.storyIndex} 开发实现结果`,
    content: [result.summary, ...(result.tests || []).map((test) => `- ${test.passed ? '通过' : '失败'}：${test.command}${test.summary ? ` — ${test.summary}` : ''}`)].join('\n\n'),
  };
  if (!artifact && delegation.agent === 'test-agent') artifact = {
    title: `交付单元 ${delegation.storyIndex} 验证结果`,
    content: [`结论：${result.verdict || result.outcome}`, result.summary, ...(result.tests || []).map((test) => `- ${test.passed ? '通过' : '失败'}：${test.command}${test.summary ? ` — ${test.summary}` : ''}`)].join('\n\n'),
  };
  if (!artifact) return null;
  let kind = artifactKinds[delegation.agent] || 'context';
  if (delegation.agent === 'review-agent') {
    const detail = await getTask(delegation.taskId);
    if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
    kind = `review_v${detail.task.review_revision + 1}`;
  }
  return upsertDocument({
    taskId: delegation.taskId,
    storyIndex: delegation.storyIndex,
    actor: delegation.agent,
    kind,
    title: artifact.title,
    content: artifact.content,
    format: 'markdown',
  });
}

async function deliveryPlanCommandChainDraftId(sourceExecutionId?: string) {
  if (!sourceExecutionId) throw new Error('交付规划结果缺少来源 execution');
  const db = await databaseConnection();
  const row = db.prepare(`
    SELECT draft_id
    FROM agent_work_drafts
    WHERE terminal_execution_id = ?
      AND command_chain_id = 'delivery-plan'
      AND status = 'submitted'
      AND terminal_action = 'complete'
  `).get(sourceExecutionId) as { draft_id: string } | undefined;
  if (!row) throw new Error('交付规划结果没有对应的已提交草稿');
  return row.draft_id;
}

async function saveQuestions(delegation: DelegationEnvelope, result: AgentResult, specRevision = 1) {
  const drafts = result.questions.length ? result.questions : [{
    title: `${delegation.agent} 需要人工处理`,
    question: result.summary,
    why: 'Agent 无法在当前上下文中安全完成该步骤。',
    recommendation: '补充信息或处理阻塞后继续。',
  }];
  for (const draft of drafts) {
    await addQuestion({
      taskId: delegation.taskId,
      storyIndex: delegation.storyIndex,
      actor: delegation.agent,
      kind: questionKind(delegation.agent),
      ...draft,
      specRevision,
      blockedReason: draft.title,
      blockTask: true,
    });
  }
}

async function saveRuntimeInputs(delegation: DelegationEnvelope, result: AgentResult, sourceExecutionId?: string) {
  for (const input of result.runtimeInputs) {
    await addRuntimeInputRequest({
      taskId: delegation.taskId,
      storyIndex: delegation.storyIndex,
      sourceAgent: delegation.agent,
      sourceKey: input.key || null,
      ...input,
      sourceExecutionId: sourceExecutionId || null,
    });
  }
}

async function recordResult(runId: string, delegation: DelegationEnvelope, result: AgentResult, codeCommit?: string, executionId?: string) {
  const db = await databaseConnection();
  if (executionId) {
    const existing = db.prepare(`
      SELECT result_id, application_status, effect_outcome
      FROM agent_results WHERE execution_id = ?
    `).get(executionId) as { result_id: string; application_status: string; effect_outcome: ApplyOutcome | null } | undefined;
    if (existing) return { resultId: existing.result_id, applicationStatus: existing.application_status, effectOutcome: existing.effect_outcome };
  }
  const resultId = randomUUID();
  db.prepare(`
    INSERT INTO agent_results(result_id, run_id, task_id, story_index, agent, pipeline, outcome, result_json, application_status, code_commit, execution_id)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(resultId, runId, delegation.taskId, delegation.storyIndex, delegation.agent, delegation.pipeline, result.outcome, JSON.stringify(result), codeCommit || null, executionId || null);
  return { resultId, applicationStatus: 'pending', effectOutcome: null };
}

async function markApplication(resultId: string, status: 'pending' | 'applied' | 'failed', error?: string | null, effectOutcome?: ApplyOutcome) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE agent_results
    SET application_status = ?,
        application_error = ?,
        applied_at = CASE WHEN ? = 'applied' THEN CURRENT_TIMESTAMP ELSE applied_at END,
        effect_outcome = COALESCE(?, effect_outcome)
    WHERE result_id = ?
  `).run(status, error || null, status, effectOutcome || null, resultId);
}

type QueuedAgentResult = {
  result_id: string;
  run_id: string;
  task_id: string;
  story_index: number | null;
  agent: string;
  pipeline: string;
  outcome: string;
  result_json: string;
  execution_id: string | null;
};

function envelopeFromTask(row: QueuedAgentResult, detail: NonNullable<Awaited<ReturnType<typeof getTask>>>): DelegationEnvelope {
  const task = detail.task;
  return {
    taskId: row.task_id,
    lane: row.agent === 'analyst-agent' ? 'analysis' : row.agent === 'dev-agent' || row.agent === 'test-agent' ? 'delivery' : 'control',
    pipeline: row.pipeline,
    agent: row.agent,
    storyIndex: row.story_index,
    resources: resourcesForAgent(row.agent),
    description: '应用排队中的 Agent 结果',
    title: task.title,
    taskDescription: task.description,
    itemType: task.item_type,
    priority: task.priority || '',
    link: task.link || '',
    externalId: task.external_id || '',
    externalStatus: task.external_status || '',
    agileStatus: task.agile_status,
    currentSubagent: task.current_subagent || '',
    resumePending: task.resume_pending,
    specResolvedIndex: task.spec_resolved_index,
    runState: task.run_state,
    closureStatus: task.closure_status,
    reviewRevision: task.review_revision,
    reviewDocumentId: task.review_document_id || '',
    lastActor: task.last_actor || '',
    analysisIndex: task.analysis_index,
    devIndex: task.dev_index,
    testIndex: task.test_index,
    totalStories: task.total_stories,
    nextStep: task.next_step || '',
    blockedReason: task.blocked_reason || '',
    owner: task.owner || '',
    evidence: task.evidence || '',
    risk: task.risk || '',
  };
}

function restoreExecutionSnapshot(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  row: QueuedAgentResult,
  result: AgentResult,
  delegation: DelegationEnvelope,
) {
  if (row.execution_id) {
    const attempt = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(row.execution_id) as import('./executions').ExecutionAttempt | undefined;
    if (attempt && (attempt.task_id !== row.task_id || attempt.agent !== row.agent
      || attempt.pipeline !== row.pipeline || attempt.story_index !== row.story_index)) {
      throw new Error('排队结果与来源 execution 不一致');
    }
    // Cancelled historical sources may predate frozen inputs and bindings.
    // Their task/role identity was checked above; the perimeter only discards.
    if (attempt && attempt.status !== 'cancelled') delegation = restoreExecutionDelegationInDb(db, attempt, delegation);
    else if (attempt?.status === 'cancelled') return delegation;
    else if (db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(row.task_id)) {
      throw new Error('原生排队结果缺少来源 execution，不得从旧游标重建');
    }
  }
  if (row.agent !== 'feedback-agent') return delegation;
  if (result.feedback?.mode === 'triage') {
    const feedbackIds = delegation.feedbackIds?.length
      ? delegation.feedbackIds
      : result.feedback.groups.flatMap((group) => group.commentIds);
    return {
      ...delegation,
      feedbackId: delegation.feedbackId || feedbackIds[0] || null,
      feedbackIds,
      feedbackBatchId: delegation.feedbackBatchId || null,
      feedbackGroupId: delegation.feedbackGroupId || null,
    };
  }
  if (result.feedback?.mode === 'verify') {
    return {
      ...delegation,
      feedbackId: delegation.feedbackId || result.feedback.commentId,
      feedbackIds: delegation.feedbackIds || null,
      feedbackBatchId: delegation.feedbackBatchId || null,
      feedbackGroupId: delegation.feedbackGroupId || null,
    };
  }
  return delegation;
}

function requireArtifact(result: AgentResult, agent: string) {
  if (!result.artifact) throw new Error(`${agent} 结果缺少 artifact`);
}

async function ensureCodeSlotForDelegation(delegation: DelegationEnvelope, result: AgentResult, sourceExecutionId?: string, workItemId?: string) {
  if (result.outcome !== 'completed' || delegation.agent !== 'dev-agent') return;
  const db = await databaseConnection();
  const claim = activeResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, delegation.taskId);
  if (claim && claim.owner_task_id !== delegation.taskId) throw new CodeSlotBusyError(claim.owner_task_id);
  if (workItemId && claim && claim.owner_execution_id !== sourceExecutionId) {
    const owner = claim.owner_execution_id ? db.prepare(`SELECT work_item_id, status FROM execution_attempts
      WHERE execution_id = ? AND task_id = ?`).get(claim.owner_execution_id, delegation.taskId) as
      { work_item_id: string | null; status: string } | undefined : undefined;
    if (!owner || owner.work_item_id !== workItemId || ['planned', 'running', 'output_received', 'verifying', 'applying'].includes(owner.status)) {
      throw new CodeSlotBusyError(claim.owner_task_id);
    }
  }
  if (!claim || (workItemId && claim.owner_execution_id !== sourceExecutionId)) {
    acquireResourceClaimInDb(db, {
      resourceKey: CODE_WORKSPACE_RESOURCE,
      taskId: delegation.taskId,
      lane: delegation.lane,
      storyIndex: delegation.storyIndex,
      ...(workItemId ? { executionId: sourceExecutionId } : {}),
    });
  }
}

export async function blockDelegation(delegation: DelegationEnvelope, reason: string, executionId?: string) {
  const db = await databaseConnection();
  if (db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(delegation.taskId)) {
    const item = nativeResultItemInDb(db, delegation, executionId);
    if (!item || !executionId) throw new Error('原生执行阻塞必须关联确切来源执行');
    if (!['running', 'waiting'].includes(item.status) || item.source_execution_status === 'cancelled') {
      throw new Error('原生阻塞来源执行已失效，不能阻塞当前工作项');
    }
    db.transaction(() => {
      openInterventionInDb(db, { taskId: delegation.taskId, itemId: item.item_id,
        sourceExecutionId: executionId, dedupeKey: `role-block:${executionId}`,
        requestedBy: delegation.agent, authority: 'arbitration', resolverStrategy: 'system_then_human',
        summary: reason, context: { purpose: 'execution_block', reason, pipeline: delegation.pipeline,
          sourceAgent: delegation.agent, storyIndex: delegation.storyIndex } });
      db.prepare('DELETE FROM resource_claims WHERE owner_execution_id = ?').run(executionId);
      db.prepare("UPDATE tasks SET next_step = ?, last_actor = 'system', updated_at = CURRENT_TIMESTAMP WHERE task_id = ?")
        .run(`工作项等待系统介入：${reason}`, delegation.taskId);
      projectNativeWorkflowDisplayInDb(db, delegation.taskId);
    })();
    return;
  }
  if (delegation.lane === 'analysis' || delegation.lane === 'delivery') {
    await setTaskLaneState({
      taskId: delegation.taskId,
      lane: delegation.lane,
      status: 'system_blocked',
      currentAgent: delegation.agent,
      currentStoryIndex: delegation.storyIndex,
      blockedReason: reason,
    });
    return;
  }
  releaseLaneExecutionResourceClaimsInDb(db, delegation.taskId, delegation.lane);
  await updateTask(delegation.taskId, 'system', {
    agile_status: 'blocked',
    current_subagent: delegation.agent,
    run_state: 'system_blocked',
    blocked_reason: reason,
    next_step: `系统阻塞：${reason}`,
  });
}

type ApplyOutcome = 'advanced' | 'blocked' | 'rewound' | 'discarded';

function nativeResultItemInDb(db: Awaited<ReturnType<typeof databaseConnection>>, delegation: DelegationEnvelope, executionId?: string) {
  const nativeTask = Boolean(db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(delegation.taskId));
  if (!executionId) {
    if (delegation.workItemId || nativeTask) throw new Error('原生工作项结果必须提供来源执行');
    return null;
  }
  const item = db.prepare(`
    SELECT item.*, execution.pipeline AS source_pipeline, execution.status AS source_execution_status
    FROM execution_attempts execution JOIN workflow_items item ON item.item_id = execution.work_item_id
    WHERE execution.execution_id = ? AND execution.task_id = ? AND item.task_id = execution.task_id
      AND item.agent = execution.agent AND item.origin = 'native'
  `).get(executionId, delegation.taskId) as (WorkflowItemRow & { source_pipeline: string; source_execution_status: string }) | undefined;
  if (nativeTask && !item || delegation.workItemId && (!item || item.item_id !== delegation.workItemId)) throw new Error('原生工作项结果缺少有效的执行绑定');
  if (item && (item.agent !== delegation.agent || item.story_index !== delegation.storyIndex || item.source_pipeline !== delegation.pipeline)) {
    throw new Error('原生结果角色、单元或 Pipeline 与来源执行不一致');
  }
  if (nativeTask && item && item.source_execution_status !== 'cancelled' && !['superseded', 'cancelled'].includes(item.status)) {
    const source = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId) as import('./executions').ExecutionAttempt;
    const frozen = restoreExecutionDelegationInDb(db, source);
    if (delegation.workItemRevision !== undefined && delegation.workItemRevision !== frozen.workItemRevision
      || delegation.workItemEpoch !== undefined && delegation.workItemEpoch !== frozen.workItemEpoch) {
      throw new Error('原生结果工作项版本或派发代次与冻结来源不一致');
    }
  }
  return item || null;
}

async function completeNativeResultWork(delegation: DelegationEnvelope, result: AgentResult, resultId?: string, executionId?: string) {
  const db = await databaseConnection();
  const item = nativeResultItemInDb(db, delegation, executionId);
  if (!item) return;
  if (!resultId || !executionId) throw new Error('原生工作项完成必须关联结果与执行');
  transitionWorkItemInDb(db, { itemId: item.item_id, action: 'complete', eventKey: `result:${resultId}`,
    actor: delegation.agent, authority: 'agent', reason: result.summary, executionId });
}

async function settleNativeResultWork(delegation: DelegationEnvelope, result: AgentResult, resultId: string, outcome: ApplyOutcome, executionId?: string) {
  if (delegation.agent === 'direct-agent' || outcome === 'discarded') return;
  const db = await databaseConnection();
  const item = nativeResultItemInDb(db, delegation, executionId);
  if (!item) return;
  if (outcome === 'advanced' && result.outcome === 'completed' && result.verdict !== 'closure_gap') {
    await completeNativeResultWork(delegation, result, resultId, executionId);
    if (delegation.agent === 'test-agent' && delegation.storyIndex) {
      await recordFeedbackUnitTestPassed({ taskId: delegation.taskId, storyIndex: delegation.storyIndex, executionId });
    }
    if (delegation.pipeline === 'feedback-verify' && delegation.feedbackBatchId) {
      finalizeTaskAfterFeedbackInDb(db, delegation.taskId, delegation.feedbackBatchId);
    }
  } else if (outcome === 'rewound' && result.businessAnalysis?.disposition === 'return_revision') {
    const workKey = result.businessAnalysis.target === 'intent' ? 'ba:intent'
      : result.businessAnalysis.target === 'business_design' ? 'ba:design' : 'ba:spec';
    const target = db.prepare(`SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = ?
      AND status NOT IN ('superseded', 'cancelled')`).get(delegation.taskId, workKey) as { item_id: string } | undefined;
    if (!target) throw new Error('规格回流缺少原生工作项目标');
    rewindWorkItemsInDb(db, { taskId: delegation.taskId, targetItemId: target.item_id, eventKey: `result:${resultId}`,
      actor: delegation.agent, authority: 'agent', reason: result.businessAnalysis.reason || result.summary });
  }
  projectNativeWorkflowDisplayInDb(db, delegation.taskId);
}

async function applyResultEffects(delegation: DelegationEnvelope, result: AgentResult, sourceResultId?: string, sourceExecutionId?: string): Promise<ApplyOutcome> {
  const sourceDb = await databaseConnection();
  // A cancelled pre-migration attempt may legitimately have no graph binding.
  // Retain its result as evidence, but never let it use legacy advancement.
  if (sourceExecutionId && sourceDb.prepare("SELECT 1 FROM execution_attempts WHERE execution_id = ? AND task_id = ? AND status = 'cancelled'")
    .get(sourceExecutionId, delegation.taskId)) return 'discarded';
  const sourceItem = nativeResultItemInDb(sourceDb, delegation, sourceExecutionId);
  if (sourceItem && (sourceItem.source_execution_status === 'cancelled' || ['superseded', 'cancelled'].includes(sourceItem.status))) return 'discarded';
  if (result.intervention) {
    assertAgentResultRoleContract(result, delegation.agent);
    if (!sourceExecutionId) throw new Error('介入请求必须来自已认证的角色终止命令');
    const db = await databaseConnection();
    return db.transaction(() => {
      const execution = db.prepare(`SELECT work_item_id, status FROM execution_attempts
        WHERE execution_id = ? AND task_id = ? AND agent = ? AND story_index IS ?`)
        .get(sourceExecutionId, delegation.taskId, delegation.agent, delegation.storyIndex) as {
          work_item_id: string | null; status: string;
        } | undefined;
      const receipt = db.prepare(`SELECT payload_json FROM execution_receipts WHERE execution_id = ?
        AND kind = 'intervention_submission' AND receipt_key = 'request'`)
        .get(sourceExecutionId) as { payload_json: string } | undefined;
      if (!execution || !receipt) throw new Error('介入请求缺少可信的角色提交收据');
      if (execution.status === 'cancelled') return 'discarded' as const;
      const submitted = JSON.parse(receipt.payload_json) as { result: AgentResult; draftId: string | null; phase: string };
      if (JSON.stringify(submitted.result) !== JSON.stringify(result)) throw new Error('介入请求与持久化的终止命令收据不一致');
      const intervention = openInterventionInDb(db, {
        taskId: delegation.taskId, itemId: execution.work_item_id,
        sourceExecutionId, dedupeKey: `role-request:${sourceExecutionId}`,
        requestedBy: delegation.agent, authority: 'arbitration', resolverStrategy: 'system_then_human',
        summary: result.summary,
        context: { reason: result.intervention!.reason, evidence: result.intervention!.evidence,
          sourceAgent: delegation.agent, pipeline: delegation.pipeline, storyIndex: delegation.storyIndex,
          draftId: submitted.draftId, phase: submitted.phase },
      });
      // Compatibility display only. The Intervention and graph own readiness.
      if (['pending', 'running', 'awaiting_human'].includes(intervention.status)) {
        if (sourceItem) {
          db.prepare('UPDATE tasks SET next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?')
            .run(`等待系统辅助仲裁：${result.summary}`, delegation.agent, delegation.taskId);
          projectNativeWorkflowDisplayInDb(db, delegation.taskId);
        } else if (delegation.lane === 'analysis' || delegation.lane === 'delivery') {
          setTaskLaneStateInDb(db, { taskId: delegation.taskId, lane: delegation.lane,
            status: 'waiting_for_runtime_input', currentAgent: delegation.agent,
            currentStoryIndex: delegation.storyIndex, blockedReason: result.summary });
        } else {
          db.prepare(`UPDATE tasks SET run_state = 'waiting_for_runtime_input', blocked_reason = ?,
            next_step = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`)
            .run(result.summary, `等待系统辅助仲裁：${result.summary}`, delegation.taskId);
        }
      }
      db.prepare('UPDATE execution_attempts SET dispatch_retry_consumed = 0 WHERE execution_id = ?').run(sourceExecutionId);
      if (sourceItem) db.prepare('DELETE FROM resource_claims WHERE owner_execution_id = ?').run(sourceExecutionId);
      else {
        releaseLaneExecutionResourceClaimsInDb(db, delegation.taskId, delegation.lane);
        if (resourcesForAgent(delegation.agent).includes(CODE_WORKSPACE_RESOURCE)) {
          releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, delegation.taskId);
        }
      }
      return 'blocked' as const;
    }).immediate();
  }
  await ensureCodeSlotForDelegation(delegation, result, sourceExecutionId, sourceItem?.item_id);

  if (delegation.agent === 'review-agent') {
    if (result.outcome !== 'completed') throw new Error('Review Agent 必须以 completed 结束事实对账');
    if (result.questions.length || result.runtimeInputs.length) {
      throw new Error('Review Agent 不得创建问题或运行信息请求；事实缺口必须转为前向交付单元');
    }
    if (result.rewindTo || result.rewindDeliveryUnit) throw new Error('Review Agent 不得返回回退决策');
    if (result.verdict === 'closure_gap') {
      if (delegation.pipeline === 'feedback-report') throw new Error('反馈报告修订只能返回 verdict=report_ready');
      if (delegation.pipeline !== 'review') throw new Error(`Review closure gap 不支持 pipeline=${delegation.pipeline}`);
      if (!result.closureGaps?.length) throw new Error('closure_gap 必须包含至少一个事实缺口');
      if (!result.closureGapUnits?.length) throw new Error('closure_gap 必须包含至少一个完整前向交付单元');
      if (result.artifact) throw new Error('closure_gap 不得生成结卡报告 artifact');
    } else if (result.verdict === 'report_ready') {
      if (!result.artifact) throw new Error('review-agent 结果缺少 artifact');
      if (result.closureGaps?.length) throw new Error('report_ready 不能同时包含 closure gaps');
      if (result.closureGapUnits?.length) throw new Error('report_ready 不能同时包含 closure gap units');
    } else {
      throw new Error('Review Agent 只能返回 verdict=report_ready 或 closure_gap');
    }
  }

  const canAskAlignmentQuestions = delegation.agent === 'backlog-agent'
    || delegation.agent === 'analyst-agent'
    || delegation.agent === 'repro-agent'
    || delegation.agent === 'feedback-agent'
    || delegation.agent === 'idea-context-agent'
    || delegation.agent === 'business-design-agent';
  if (result.questions.length && !canAskAlignmentQuestions) {
    throw new Error(`${delegation.agent} 不允许创建业务或交付决策问题；运行所需信息请使用 runtimeInputs`);
  }
  if (delegation.agent === 'repro-agent' && result.runtimeInputs.length) {
    throw new Error('repro-agent 未复现时必须通过 questions 请求人工对齐，不能使用 runtimeInputs');
  }
  if (result.questions.length && result.runtimeInputs.length) throw new Error('同一次结果不能混合业务/交付决策问题和运行信息请求');
  if (result.runtimeInputs.length) {
    if (result.outcome !== 'needs_input') throw new Error('包含 runtimeInputs 时 outcome 必须为 needs_input');
    await saveRuntimeInputs(delegation, result, sourceExecutionId);
    return 'blocked' as const;
  }
  if (delegation.agent === 'repro-agent' && result.outcome === 'needs_input') {
    if (result.reproVerdict !== 'not_reproduced' || !result.artifact || !result.questions.length || result.route) {
      throw new Error('未复现问题时必须保存证据、请求人工对齐且不能进入后续路由');
    }
  }
  const hasTestFailureVerdict = delegation.agent === 'test-agent' && result.verdict === 'failed';
  if (result.outcome !== 'completed' && !(canAskAlignmentQuestions && result.questions.length) && !hasTestFailureVerdict) {
    await blockDelegation(delegation, result.summary, sourceExecutionId);
    return 'blocked' as const;
  }

  if (delegation.agent === 'feedback-agent') {
    if (result.questions.length) {
      if (result.feedback) throw new Error('Feedback Agent 不能同时提问和提交反馈分组');
      if (!delegation.feedbackBatchId) throw new Error('Feedback Agent 提问缺少反馈批次');
      await saveQuestions(delegation, result);
      await markFeedbackBatchWaitingForAnswers(delegation.taskId, delegation.feedbackBatchId);
      return 'blocked';
    }
    if (!result.feedback) throw new Error('Feedback Agent 缺少反馈结果');
    if (delegation.pipeline === 'feedback-triage' && result.feedback.mode !== 'triage') throw new Error('Feedback Triage 必须返回 mode=triage');
    if (delegation.pipeline === 'feedback-verify' && result.feedback.mode !== 'verify') throw new Error('Feedback Verify 必须返回 mode=verify');
    if (result.feedback.mode === 'triage') {
      if (!delegation.feedbackBatchId) throw new Error('Feedback Triage 缺少反馈批次');
      await applyFeedbackTriageGroups({
        taskId: delegation.taskId,
        batchId: delegation.feedbackBatchId,
        groups: result.feedback.groups,
        summary: result.summary,
        executionId: sourceExecutionId,
      });
    } else {
      if (!delegation.feedbackId || result.feedback.commentId !== delegation.feedbackId) throw new Error('Feedback Agent 返回了错误的 commentId');
      await applyFeedbackVerificationV2(delegation.taskId, result.feedback, sourceExecutionId);
    }
    return 'advanced';
  }

  if (delegation.agent === 'review-agent' && !sourceItem) {
    const detail = await getTask(delegation.taskId);
    if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
    if (delegation.pipeline === 'review') {
      if (result.verdict !== 'closure_gap'
        && (detail.task.agile_status !== 'in review'
        || detail.task.current_subagent !== 'review-agent'
        || detail.task.closure_status !== 'none')) {
        return 'discarded';
      }
    } else if (delegation.pipeline === 'feedback-report') {
      if (!delegation.feedbackBatchId || !delegation.feedbackGroupId) {
        throw new Error('反馈报告更正缺少批次或分组');
      }
      const db = await databaseConnection();
      const current = db.prepare(`
        SELECT 1
        FROM feedback_batches batch
        JOIN feedback_groups group_item
          ON group_item.batch_id = batch.batch_id
        WHERE batch.task_id = ?
          AND batch.batch_id = ?
          AND group_item.group_id = ?
          AND batch.status = 'reporting'
          AND group_item.status = 'executing'
          AND group_item.work_type = 'report_correction'
        LIMIT 1
      `).get(delegation.taskId, delegation.feedbackBatchId, delegation.feedbackGroupId);
      if (
        detail.task.agile_status !== 'in feedback'
        || detail.task.review_document_id !== delegation.reviewDocumentId
        || detail.task.review_revision !== delegation.reviewRevision
        || !current
      ) return 'discarded';
    } else {
      throw new Error(`Review Agent 不支持 pipeline=${delegation.pipeline}`);
    }
  }

  const artifactDocumentId = delegation.agent === 'review-agent'
    ? null
    : await saveArtifact(delegation, result);
  const actor = delegation.agent as Actor;
  // Native workflow advancement is committed by settleNativeResultWork.
  // Only artifact-head metadata and human-input consumption remain here;
  // old cursor/Lane validations belong exclusively to compatibility tasks.
  const publishProgress: typeof updateTask = sourceItem ? async (taskId, actor, changes) => {
    const db = await databaseConnection();
    db.transaction(() => {
      db.prepare(`UPDATE tasks SET next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`)
        .run(changes.next_step || result.summary, actor, taskId);
      if (changes.review_document_id && changes.review_revision !== undefined) {
        db.prepare('UPDATE tasks SET review_document_id = ?, review_revision = ? WHERE task_id = ?')
          .run(changes.review_document_id, changes.review_revision, taskId);
        if (!sourceExecutionId || !sourceResultId) throw new Error('原生最终规格发布缺少来源执行或结果');
        const finalDocument = finalDocumentSnapshotInDb(db, taskId);
        if (!finalDocument) throw new Error('原生最终规格发布缺少同需求文档');
        db.prepare(`INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
          VALUES(?, ?, 'work_item_artifact', 'business_analysis_specification', ?)`)
          .run(randomUUID(), sourceExecutionId, JSON.stringify({ ...finalDocument, itemId: sourceItem.item_id,
            revision: sourceItem.revision, resultId: sourceResultId }));
      }
      if (['backlog-agent', 'repro-agent'].includes(actor) && result.outcome === 'completed' && !result.questions.length) {
        db.prepare(`UPDATE questions SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE task_id = ? AND source_agent = ? AND status = 'answered'
            AND intervention_id IN (SELECT intervention_id FROM interventions WHERE item_id = ? AND task_id = ?)`)
          .run(taskId, actor, sourceItem.item_id, taskId);
      }
      db.prepare("INSERT INTO task_events(event_id, task_id, actor, event_type, summary) VALUES(?, ?, ?, 'AgentResultRecorded', ?)")
        .run(randomUUID(), taskId, actor, result.summary);
    })();
    projectNativeWorkflowDisplayInDb(db, taskId);
  } : updateTask;
  switch (delegation.agent) {
    case 'direct-agent': {
      if (!artifactDocumentId) throw new Error('Direct Agent 缺少最终结果文档');
      await completeNativeResultWork(delegation, result, sourceResultId, sourceExecutionId);
      await publishProgress(delegation.taskId, actor, {
        agile_status: 'done',
        current_subagent: null,
        run_state: 'idle',
        closure_status: 'acknowledged',
        closure_acknowledged_at: new Date().toISOString(),
        next_step: result.summary,
      });
      return 'advanced';
    }
    case 'idea-context-agent': {
      if (result.questions.length) {
        await saveQuestions(delegation, result);
        return 'blocked';
      }
      requireArtifact(result, delegation.agent);
      if (result.businessAnalysis?.disposition !== 'advance') throw new Error('需求意图 Agent 必须完成意图简报或请求澄清');
      await publishProgress(delegation.taskId, actor, {
        agile_status: 'backlog',
        current_subagent: 'business-design-agent',
        next_step: '需求意图已确认，等待业务方案设计',
      });
      return 'advanced';
    }
    case 'business-design-agent': {
      if (result.questions.length) {
        await saveQuestions(delegation, result);
        return 'blocked';
      }
      if (result.businessAnalysis?.disposition === 'return_revision') {
        const target = result.businessAnalysis.target;
        if (target !== 'intent') throw new Error('业务方案 Agent 只能把上游缺口返回需求意图');
        await publishProgress(delegation.taskId, actor, {
          agile_status: 'backlog',
          current_subagent: 'idea-context-agent',
          next_step: result.businessAnalysis.reason || result.summary,
        });
        return 'rewound';
      }
      requireArtifact(result, delegation.agent);
      if (result.businessAnalysis?.disposition !== 'advance') throw new Error('业务方案 Agent 缺少推进结果');
      await publishProgress(delegation.taskId, actor, {
        agile_status: 'backlog',
        current_subagent: 'requirement-spec-agent',
        next_step: '业务方案已确定，等待编写需求规格说明书',
      });
      return 'advanced';
    }
    case 'requirement-spec-agent': {
      if (result.businessAnalysis?.disposition === 'return_revision') {
        const targetAgent = result.businessAnalysis.target === 'intent'
          ? 'idea-context-agent'
          : result.businessAnalysis.target === 'business_design'
            ? 'business-design-agent'
            : null;
        if (!targetAgent) throw new Error('需求规格缺口必须返回需求意图或业务方案');
        await publishProgress(delegation.taskId, actor, {
          agile_status: 'backlog',
          current_subagent: targetAgent,
          next_step: result.businessAnalysis.reason || result.summary,
        });
        return 'rewound';
      }
      requireArtifact(result, delegation.agent);
      if (result.businessAnalysis?.disposition !== 'advance') throw new Error('需求规格 Agent 缺少推进结果');
      await publishProgress(delegation.taskId, actor, {
        agile_status: 'backlog',
        current_subagent: 'spec-review-agent',
        next_step: '需求规格草稿已完成，等待独立规格审查',
      });
      return 'advanced';
    }
    case 'spec-review-agent': {
      if (result.businessAnalysis?.disposition === 'return_revision') {
        const targetAgent = result.businessAnalysis.target === 'intent'
          ? 'idea-context-agent'
          : result.businessAnalysis.target === 'business_design'
            ? 'business-design-agent'
            : result.businessAnalysis.target === 'specification'
              ? 'requirement-spec-agent'
              : null;
        if (!targetAgent) throw new Error('规格审查回流缺少有效目标');
        await publishProgress(delegation.taskId, actor, {
          agile_status: 'backlog',
          current_subagent: targetAgent,
          next_step: result.businessAnalysis.reason || result.summary,
        });
        return 'rewound';
      }
      requireArtifact(result, delegation.agent);
      if (result.businessAnalysis?.disposition !== 'approved') throw new Error('规格审查必须批准或回流');
      if (!artifactDocumentId) throw new Error('规格审查批准缺少最终需求规格文档');
      const detail = await getTask(delegation.taskId);
      if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
      if (detail.task.item_type === 'end-to-end') {
        await publishProgress(delegation.taskId, actor, {
          agile_status: 'backlog',
          current_subagent: 'backlog-agent',
          run_state: 'runnable',
          closure_status: 'none',
          next_step: '需求规格已通过独立审查，自动进入 Develop 需求梳理',
        });
        return 'advanced';
      }
      await publishProgress(delegation.taskId, actor, {
        agile_status: 'ready_to_close',
        current_subagent: null,
        run_state: 'idle',
        closure_status: 'awaiting_read',
        review_revision: detail.task.review_revision + 1,
        review_document_id: artifactDocumentId,
        next_step: '需求规格已通过独立审查，等待用户阅读确认',
      });
      await resolveBusinessAnalysisSpecificationComments({
        taskId: delegation.taskId,
        revision: detail.task.review_revision + 1,
      });
      return 'advanced';
    }
    case 'backlog-agent': {
      if (result.questions.length) {
        await saveQuestions(delegation, result);
        return 'blocked' as const;
      }
      const detail = await getTask(delegation.taskId);
      if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
      const retainsCodeSlot = detail.task.agile_status === 'in dev' && detail.task.total_stories === 0;
      const nextRoute = detail.task.item_type === 'bug' ? 'repro' : 'plan';
      await publishProgress(delegation.taskId, actor, {
        ...(retainsCodeSlot ? {} : { agile_status: nextRoute === 'repro' ? 'in repro' as const : 'in plan' as const }),
        current_subagent: nextRoute === 'repro' ? 'repro-agent' : 'story-splitter-agent',
        next_step: result.summary,
      });
      return 'advanced' as const;
    }
    case 'story-splitter-agent': {
      if (!result.deliveryUnits?.length) throw new Error('交付规划 Agent 结果缺少 deliveryUnits');
      const sourceCommandChainDraftId = await deliveryPlanCommandChainDraftId(sourceExecutionId);
      if (delegation.pipeline === 'feedback-split') {
        if (!delegation.feedbackBatchId || !delegation.feedbackGroupId) throw new Error('反馈追加拆分缺少批次或分组');
        await applyFeedbackSplitResult({
          taskId: delegation.taskId,
          batchId: delegation.feedbackBatchId,
          groupId: delegation.feedbackGroupId,
          deliveryUnits: result.deliveryUnits,
          executionId: sourceExecutionId,
          sourceCommandChainDraftId,
        });
        return 'advanced';
      }
      const detail = await getTask(delegation.taskId);
      if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
      await addPlannedDeliveryUnits({
        taskId: delegation.taskId,
        actor,
        units: result.deliveryUnits,
        sourceCommandChainDraftId,
      });
      await publishProgress(delegation.taskId, actor, {
        agile_status: detail.task.agile_status === 'in dev' ? 'in dev' : 'ready for dev',
        current_subagent: 'analyst-agent',
        next_step: `已拆分 ${result.deliveryUnits.length} 个交付单元，等待逐个进行交付分析`,
      });
      return 'advanced' as const;
    }
    case 'analyst-agent': {
      requireArtifact(result, delegation.agent);
      if (!delegation.storyIndex) throw new Error('交付分析 Agent 缺少交付单元序号');
      if (result.questions.length) {
        if (result.spec) {
          if (!result.spec.decisions.some((decision) => decision.status === 'needs_user_input')) {
            throw new Error('交付分析 Agent 提问时必须在交付规格中列出对应待确认决策');
          }
          const saved = await saveDeliverySpec({
            taskId: delegation.taskId,
            storyIndex: delegation.storyIndex,
            status: 'waiting_for_answers',
            spec: result.spec,
            sourceResultId,
          });
          await saveQuestions(delegation, result, saved.revision);
        } else {
          await saveQuestions(delegation, result);
        }
        return 'blocked' as const;
      }
      if (result.outcome !== 'completed') throw new Error('没有待澄清问题时，交付分析 Agent 必须完成当前规格');
      if (!result.spec) throw new Error('交付分析 Agent 完成结果缺少结构化交付规格');
      await saveDeliverySpec({
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        status: 'resolved',
        spec: result.spec,
        sourceResultId,
      });
      await publishProgress(delegation.taskId, actor, {
        analysis_index: delegation.storyIndex,
        spec_resolved_index: delegation.storyIndex,
        next_step: delegation.pipeline === 'resume'
          ? `交付单元 ${delegation.storyIndex} 的交付规格已按人工答复收敛`
          : `交付单元 ${delegation.storyIndex} 的交付分析完成，无待确认关键决策`,
      });
      await recordRecoveryClaims({
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        agent: delegation.agent,
        executionId: sourceExecutionId,
        claims: result.recoveryResolutions,
      });
      return 'advanced' as const;
    }
    case 'repro-agent': {
      requireArtifact(result, delegation.agent);
      if (result.reproVerdict === 'not_reproduced') {
        if (result.outcome !== 'needs_input' || !result.questions.length) throw new Error('未复现问题时必须请求人工对齐');
        if (result.route) throw new Error('未复现问题时不能进入后续路由');
        await saveQuestions(delegation, result);
        if (delegation.pipeline === 'feedback-repro') {
          if (!delegation.feedbackBatchId) throw new Error('反馈复现缺少反馈批次');
          await markFeedbackBatchWaitingForAnswers(delegation.taskId, delegation.feedbackBatchId);
        }
        return 'blocked' as const;
      }
      if (result.reproVerdict !== 'reproduced') throw new Error('repro-agent 结果缺少 reproVerdict');
      if (result.outcome !== 'completed' || result.route !== 'plan') throw new Error('只有成功复现后才能 route=plan');
      if (delegation.pipeline === 'feedback-repro') {
        if (!delegation.feedbackBatchId || !delegation.feedbackGroupId) throw new Error('反馈复现缺少批次或分组');
        await applyFeedbackReproResult({
          taskId: delegation.taskId,
          batchId: delegation.feedbackBatchId,
          groupId: delegation.feedbackGroupId,
          result,
          executionId: sourceExecutionId,
        });
        return 'advanced';
      }
      const detail = await getTask(delegation.taskId);
      if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
      const retainsCodeSlot = detail.task.agile_status === 'in dev' && detail.task.total_stories === 0;
      await publishProgress(delegation.taskId, actor, {
        ...(retainsCodeSlot ? {} : { agile_status: 'in plan' as const }),
        current_subagent: 'story-splitter-agent',
        next_step: result.summary,
      });
      return 'advanced' as const;
    }
    case 'dev-agent': {
      if (!delegation.storyIndex) throw new Error('开发实现 Agent 缺少交付单元序号');
      const detail = await getTask(delegation.taskId);
      if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
      await publishProgress(delegation.taskId, actor, {
        agile_status: detail.task.agile_status === 'in feedback' ? 'in feedback' : 'in dev',
        current_subagent: 'dev-agent',
        dev_index: delegation.storyIndex,
        next_step: result.summary,
      });
      await recordRecoveryClaims({
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        agent: delegation.agent,
        executionId: sourceExecutionId,
        claims: result.recoveryResolutions,
      });
      return 'advanced' as const;
    }
    case 'test-agent': {
      if (!delegation.storyIndex || !result.verdict) throw new Error('验证 Agent 结果缺少交付单元序号或 verdict');
      if (result.verdict === 'passed') {
        const detail = await getTask(delegation.taskId);
        if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
        const complete = delegation.storyIndex === detail.task.total_stories && detail.task.dev_index === detail.task.total_stories && detail.task.analysis_index === detail.task.total_stories;
        const inFeedback = detail.task.agile_status === 'in feedback';
        await publishProgress(delegation.taskId, actor, {
          agile_status: inFeedback ? 'in feedback' : complete ? 'in review' : 'in dev',
          current_subagent: inFeedback ? 'test-agent' : complete ? 'review-agent' : 'test-agent',
          test_index: delegation.storyIndex,
          next_step: result.summary,
        });
        if (inFeedback && !sourceItem) {
          await recordFeedbackUnitTestPassed({
            taskId: delegation.taskId,
            storyIndex: delegation.storyIndex,
            executionId: sourceExecutionId,
          });
        }
        await resolveActiveRecoveryItems({
          taskId: delegation.taskId,
          storyIndex: delegation.storyIndex,
          kind: 'test_failure',
          verifier: delegation.agent,
          executionId: sourceExecutionId,
          summary: result.summary,
        });
        const db = await databaseConnection();
        if (sourceItem) db.prepare(`DELETE FROM resource_claims WHERE owner_execution_id = ? OR (resource_key = 'code:workspace' AND owner_execution_id IN (
          SELECT execution.execution_id FROM execution_attempts execution
          JOIN workflow_dependencies dependency ON dependency.depends_on_item_id = execution.work_item_id
          JOIN workflow_items predecessor ON predecessor.item_id = dependency.depends_on_item_id
          WHERE dependency.item_id = ? AND predecessor.task_id = ? AND predecessor.agent = 'dev-agent'
            AND execution.task_id = predecessor.task_id
            AND execution.status NOT IN ('planned', 'running', 'output_received', 'verifying', 'applying')
        ))`).run(sourceExecutionId, sourceItem.item_id, delegation.taskId);
        else releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, delegation.taskId);
        return 'advanced' as const;
      }
      const failureKind = result.failureKind
        || (result.rewindTo === 'analysis' ? 'specification' : result.rewindTo === 'dev' ? 'implementation' : 'inconclusive');
      if (failureKind === 'environment' || failureKind === 'inconclusive') {
        await blockDelegation(
          delegation,
          `${failureKind === 'environment' ? '验证环境异常' : '验证结论无法确定'}：${result.summary}`,
          sourceExecutionId,
        );
        return 'blocked' as const;
      }
      const target = failureKind === 'specification' ? 'analysis' : 'dev';
      const storyIndex = result.rewindDeliveryUnit || delegation.storyIndex;
      const db = await databaseConnection();
      const observation = sourceExecutionId
        ? observeWorkflowFailureInDb(db, {
          executionId: sourceExecutionId,
          taskId: delegation.taskId,
          storyIndex,
          failureKind,
          summary: result.summary,
          tests: result.tests,
        })
        : null;
      if (observation?.shouldArbitrate && observation.stagnationFingerprint) {
        db.transaction(() => {
          openInterventionInDb(db, {
            taskId: delegation.taskId,
            itemId: observation.workItemId,
            dedupeKey: `workflow-stagnation:${observation.workItemId}:${observation.stagnationFingerprint}`,
            summary: `同一验证失败在代码与交付契约均未变化时连续出现 ${observation.stagnantCount} 次，需要仲裁后再推进`,
            context: {
              failureKind,
              deliveryUnit: storyIndex,
              failedSummary: result.summary,
              tests: result.tests || [],
              currentExecutionId: sourceExecutionId,
              previousExecutionId: observation.previousExecutionId,
              workItemId: observation.workItemId,
              repositoryFingerprint: observation.repositoryFingerprint,
              contractFingerprint: observation.contractFingerprint,
              failureSignature: observation.failureSignature,
            },
            requestedBy: delegation.agent,
            sourceExecutionId,
            resolverStrategy: 'system_then_human',
            authority: 'arbitration',
            maxSystemAttempts: 3,
          });
          db.prepare(`
            UPDATE tasks
            SET next_step = ?, blocked_reason = ?, updated_at = CURRENT_TIMESTAMP
            WHERE task_id = ?
          `).run(
            `检测到无进展的重复验证失败，已交给系统仲裁 Agent（最多 3 次）：${result.summary}`,
            result.summary,
            delegation.taskId,
          );
          setTaskLaneStateInDb(db, {
            taskId: delegation.taskId,
            lane: 'delivery',
            status: 'waiting_for_runtime_input',
            currentAgent: delegation.agent,
            currentStoryIndex: storyIndex,
            blockedReason: result.summary,
          });
        }).immediate();
        return 'blocked' as const;
      }
      await createOrReopenRecoveryItem({
        taskId: delegation.taskId,
        storyIndex,
        kind: 'test_failure',
        sourceAgent: delegation.agent,
        targetStage: target,
        summary: result.summary,
        details: {
          verdict: result.verdict,
          expected: '当前交付单元满足已收敛的交付规格与验收标准',
          actual: result.summary,
          tests: result.tests || [],
          failureKind,
          rewindTo: target,
        },
        sourceExecutionId,
      });
      await rewindTask({ taskId: delegation.taskId, actor, to: target, story: storyIndex, reason: result.summary,
        eventKey: sourceExecutionId ? `test-result:${sourceExecutionId}` : undefined });
      return 'rewound' as const;
    }
    case 'review-agent': {
      if (result.verdict === 'closure_gap') {
        if (!sourceResultId) throw new Error('Review closure gap 缺少来源 result');
        const forwarding = await forwardReviewClosureGaps({
          taskId: delegation.taskId,
          sourceResultId,
          gaps: result.closureGaps || [],
          units: result.closureGapUnits || [],
          expected: {
            totalStories: delegation.totalStories,
            reviewRevision: delegation.reviewRevision,
            reviewDocumentId: delegation.reviewDocumentId,
          },
        });
        return forwarding === 'stale' ? 'discarded' : 'advanced';
      }
      if (!sourceResultId) throw new Error('Review report_ready 缺少来源 result');
      return publishReviewReport({
        delegation,
        result,
        resultId: sourceResultId,
        executionId: sourceExecutionId,
      });
    }
    default:
      throw new Error(`不支持的 agent：${delegation.agent}`);
  }
}

export async function applyAgentResult(runId: string, delegation: DelegationEnvelope, result: AgentResult, options: { codeCommit?: string; executionId?: string } = {}) {
  const recorded = await recordResult(runId, delegation, result, options.codeCommit, options.executionId);
  if (recorded.applicationStatus === 'applied') return recorded.effectOutcome || 'advanced';
  if (recorded.applicationStatus === 'failed') throw new Error('该 execution attempt 的 Agent 结果此前应用失败，拒绝重复产生副作用');
  const resultId = recorded.resultId;
  const current = await getTask(delegation.taskId);
  const db = await databaseConnection();
  if (!current || current.task.is_paused || workflowEndedInDb(db, delegation.taskId)) {
    await markApplication(resultId, 'applied', null, 'discarded');
    return 'discarded' as const;
  }
  try {
    const outcome = await applyResultEffects(delegation, result, resultId, options.executionId);
    if (result.outcome === 'completed' && outcome !== 'discarded') {
      await resolveRuntimeInputs({
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        sourceAgent: delegation.agent,
        resolvedExecutionId: options.executionId,
      });
    }
    await settleNativeResultWork(delegation, result, resultId, outcome, options.executionId);
    await markApplication(resultId, 'applied', null, outcome);
    return outcome;
  } catch (error) {
    if (error instanceof CodeSlotBusyError) {
      await markApplication(resultId, 'pending', error.message);
      throw error;
    }
    await markApplication(resultId, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export type QueuedApplicationResult =
  | { status: 'none' }
  | { status: 'applied'; resultId: string; taskId: string; storyIndex: number | null; agent: string; outcome: ApplyOutcome }
  | { status: 'waiting'; resultId: string; taskId: string; storyIndex: number | null; agent: string; ownerTaskId: string }
  | { status: 'failed'; resultId: string; taskId: string; storyIndex: number | null; agent: string; reason: string; willRetry: boolean };

export async function applyNextQueuedAgentResult(): Promise<QueuedApplicationResult> {
  const db = await databaseConnection();
  const rows = db.prepare(`
    SELECT ar.result_id, ar.run_id, ar.task_id, ar.story_index, ar.agent, ar.pipeline, ar.outcome, ar.result_json, ar.execution_id
    FROM agent_results ar
    JOIN tasks t ON t.task_id = ar.task_id
    WHERE ar.application_status = 'pending'
      AND t.is_paused = 0
      AND t.workflow_engine = 'native'
    ORDER BY ar.created_at, ar.result_id
  `).all() as QueuedAgentResult[];
  const row = rows.find(candidate => !workflowResultHeldInDb(db, candidate.task_id, candidate.execution_id));
  if (!row) return { status: 'none' };

  try {
    const detail = await getTask(row.task_id);
    if (!detail) throw new Error(`需求不存在：${row.task_id}`);
    if (workflowEndedInDb(db, row.task_id)) {
      await markApplication(row.result_id, 'applied', null, 'discarded');
      if (row.execution_id) {
        db.prepare(`
          UPDATE execution_attempts
          SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
          WHERE execution_id = ? AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
        `).run(row.execution_id);
      }
      return { status: 'applied', resultId: row.result_id, taskId: row.task_id, storyIndex: row.story_index, agent: row.agent, outcome: 'discarded' };
    }
    const result = parseAgentResult(row.result_json);
    const delegation = restoreExecutionSnapshot(
      db,
      row,
      result,
      envelopeFromTask(row, detail),
    );
    const outcome = await applyResultEffects(delegation, result, row.result_id, row.execution_id || undefined);
    if (result.outcome === 'completed' && outcome !== 'discarded') {
      await resolveRuntimeInputs({
        taskId: row.task_id,
        storyIndex: row.story_index,
        sourceAgent: row.agent,
        resolvedExecutionId: row.execution_id || undefined,
      });
    }
    await settleNativeResultWork(delegation, result, row.result_id, outcome, row.execution_id || undefined);
    await markApplication(row.result_id, 'applied', null, outcome);
    const execution = db.prepare('SELECT execution_id FROM agent_results WHERE result_id = ?').get(row.result_id) as { execution_id: string | null } | undefined;
    if (execution?.execution_id) {
      db.prepare(`
        UPDATE execution_attempts
        SET status = 'applied', finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
          WHERE execution_id = ? AND status != 'cancelled'
      `).run(execution.execution_id);
      releaseExecutionResourceClaimsInDb(db, execution.execution_id);
      db.prepare(`
        INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
        VALUES(?, ?, 'application', ?, ?)
        ON CONFLICT(execution_id, kind, receipt_key) DO NOTHING
      `).run(randomUUID(), execution.execution_id, outcome, JSON.stringify({ outcome, source: 'application_queue' }));
    }
    const lane = laneForAgent(row.agent);
    if (lane !== 'control') {
      const refreshed = await getTask(row.task_id);
      if (refreshed) settleTaskLaneInDb(db, refreshed.task, lane);
    }
    return { status: 'applied', resultId: row.result_id, taskId: row.task_id, storyIndex: row.story_index, agent: row.agent, outcome };
  } catch (error) {
    if (error instanceof CodeSlotBusyError) {
      await markApplication(row.result_id, 'pending', error.message);
      return { status: 'waiting', resultId: row.result_id, taskId: row.task_id, storyIndex: row.story_index, agent: row.agent, ownerTaskId: error.ownerTaskId };
    }
    const reason = error instanceof Error ? error.message : String(error);
    await markApplication(row.result_id, 'failed', reason);
    let willRetry = false;
    if (row.execution_id) {
      const retry = await failExecutionWithRetryPolicy(
        row.execution_id,
        `应用排队中的 Agent 结果失败：${reason}`,
        { kind: 'agent-result-application', maxRetries: EXECUTION_FAILURE_MAX_RETRIES },
      );
      willRetry = !retry.ignored && retry.willRetry;
    }
    return {
      status: 'failed',
      resultId: row.result_id,
      taskId: row.task_id,
      storyIndex: row.story_index,
      agent: row.agent,
      reason,
      willRetry,
    };
  }
}
