import { randomUUID } from 'node:crypto';
import { parseAgentResult, type AgentResult } from '../domain/agent-result';
import type { Actor } from '../domain/task';
import { resourcesForAgent } from '../domain/resource';
import { databaseConnection } from '../infrastructure/database';
import { laneForAgent, settleTaskLaneInDb } from './task-lanes';
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

async function deliveryPlanDraftId(sourceExecutionId?: string) {
  if (!sourceExecutionId) throw new Error('交付规划结果缺少来源 execution');
  const db = await databaseConnection();
  const row = db.prepare(`
    SELECT draft_id
    FROM agent_work_drafts
    WHERE terminal_execution_id = ?
      AND draft_type = 'delivery_plan'
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
  let stored: DelegationEnvelope | null = null;
  if (row.execution_id) {
    const attempt = db.prepare('SELECT input_json FROM execution_attempts WHERE execution_id = ?').get(row.execution_id) as { input_json: string } | undefined;
    if (attempt?.input_json) {
      try {
        const parsed = JSON.parse(attempt.input_json) as { delegation?: DelegationEnvelope };
        stored = parsed.delegation || null;
      } catch {
        throw new Error('排队结果关联的 execution delegation 快照无法读取');
      }
    }
  }
  if (stored) {
    if (
      stored.taskId !== row.task_id
      || stored.agent !== row.agent
      || stored.pipeline !== row.pipeline
      || stored.storyIndex !== row.story_index
    ) {
      throw new Error('排队结果与 execution delegation 快照不一致');
    }
    delegation = stored;
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

async function ensureCodeSlotForDelegation(delegation: DelegationEnvelope, result: AgentResult) {
  if (result.outcome !== 'completed' || delegation.agent !== 'dev-agent') return;
  const db = await databaseConnection();
  const claim = activeResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE);
  if (claim && claim.owner_task_id !== delegation.taskId) throw new CodeSlotBusyError(claim.owner_task_id);
  if (!claim) {
    acquireResourceClaimInDb(db, {
      resourceKey: CODE_WORKSPACE_RESOURCE,
      taskId: delegation.taskId,
      lane: delegation.lane,
      storyIndex: delegation.storyIndex,
    });
  }
}

export async function blockDelegation(delegation: DelegationEnvelope, reason: string) {
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
  const db = await databaseConnection();
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

async function applyResultEffects(delegation: DelegationEnvelope, result: AgentResult, sourceResultId?: string, sourceExecutionId?: string): Promise<ApplyOutcome> {
  await ensureCodeSlotForDelegation(delegation, result);

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
    await blockDelegation(delegation, result.summary);
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

  if (delegation.agent === 'review-agent') {
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
  switch (delegation.agent) {
    case 'direct-agent': {
      if (!artifactDocumentId) throw new Error('Direct Agent 缺少最终结果文档');
      await updateTask(delegation.taskId, actor, {
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
      await updateTask(delegation.taskId, actor, {
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
        await updateTask(delegation.taskId, actor, {
          agile_status: 'backlog',
          current_subagent: 'idea-context-agent',
          next_step: result.businessAnalysis.reason || result.summary,
        });
        return 'rewound';
      }
      requireArtifact(result, delegation.agent);
      if (result.businessAnalysis?.disposition !== 'advance') throw new Error('业务方案 Agent 缺少推进结果');
      await updateTask(delegation.taskId, actor, {
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
        await updateTask(delegation.taskId, actor, {
          agile_status: 'backlog',
          current_subagent: targetAgent,
          next_step: result.businessAnalysis.reason || result.summary,
        });
        return 'rewound';
      }
      requireArtifact(result, delegation.agent);
      if (result.businessAnalysis?.disposition !== 'advance') throw new Error('需求规格 Agent 缺少推进结果');
      await updateTask(delegation.taskId, actor, {
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
        await updateTask(delegation.taskId, actor, {
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
        await updateTask(delegation.taskId, actor, {
          agile_status: 'backlog',
          current_subagent: 'backlog-agent',
          run_state: 'runnable',
          closure_status: 'none',
          next_step: '需求规格已通过独立审查，自动进入 Develop 需求梳理',
        });
        return 'advanced';
      }
      await updateTask(delegation.taskId, actor, {
        agile_status: 'ready_to_close',
        current_subagent: null,
        run_state: 'idle',
        closure_status: 'awaiting_read',
        review_revision: detail.task.review_revision + 1,
        review_document_id: artifactDocumentId,
        next_step: '需求规格已通过独立审查，等待用户阅读确认',
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
      await updateTask(delegation.taskId, actor, {
        ...(retainsCodeSlot ? {} : { agile_status: nextRoute === 'repro' ? 'in repro' as const : 'in plan' as const }),
        current_subagent: nextRoute === 'repro' ? 'repro-agent' : 'story-splitter-agent',
        next_step: result.summary,
      });
      return 'advanced' as const;
    }
    case 'story-splitter-agent': {
      if (!result.deliveryUnits?.length) throw new Error('交付规划 Agent 结果缺少 deliveryUnits');
      const sourceDeliveryPlanDraftId = await deliveryPlanDraftId(sourceExecutionId);
      if (delegation.pipeline === 'feedback-split') {
        if (!delegation.feedbackBatchId || !delegation.feedbackGroupId) throw new Error('反馈追加拆分缺少批次或分组');
        await applyFeedbackSplitResult({
          taskId: delegation.taskId,
          batchId: delegation.feedbackBatchId,
          groupId: delegation.feedbackGroupId,
          deliveryUnits: result.deliveryUnits,
          executionId: sourceExecutionId,
          sourceDeliveryPlanDraftId,
        });
        return 'advanced';
      }
      const detail = await getTask(delegation.taskId);
      if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
      await addPlannedDeliveryUnits({
        taskId: delegation.taskId,
        actor,
        units: result.deliveryUnits,
        sourceDeliveryPlanDraftId,
      });
      await updateTask(delegation.taskId, actor, {
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
      await updateTask(delegation.taskId, actor, {
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
      await updateTask(delegation.taskId, actor, {
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
      await updateTask(delegation.taskId, actor, {
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
        await updateTask(delegation.taskId, actor, {
          agile_status: inFeedback ? 'in feedback' : complete ? 'in review' : 'in dev',
          current_subagent: inFeedback ? 'test-agent' : complete ? 'review-agent' : 'test-agent',
          test_index: delegation.storyIndex,
          next_step: result.summary,
        });
        if (inFeedback) {
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
        releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, delegation.taskId);
        return 'advanced' as const;
      }
      const failureKind = result.failureKind
        || (result.rewindTo === 'analysis' ? 'specification' : result.rewindTo === 'dev' ? 'implementation' : 'inconclusive');
      if (failureKind === 'environment' || failureKind === 'inconclusive') {
        await blockDelegation(
          delegation,
          `${failureKind === 'environment' ? '验证环境异常' : '验证结论无法确定'}：${result.summary}`,
        );
        return 'blocked' as const;
      }
      const target = failureKind === 'specification' ? 'analysis' : 'dev';
      await createOrReopenRecoveryItem({
        taskId: delegation.taskId,
        storyIndex: result.rewindDeliveryUnit || delegation.storyIndex,
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
      await rewindTask({ taskId: delegation.taskId, actor, to: target, story: result.rewindDeliveryUnit || delegation.storyIndex, reason: result.summary });
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
  if (!current || current.task.is_paused || ['done', 'cancelled'].includes(current.task.agile_status)) {
    await markApplication(resultId, 'applied', null, 'discarded');
    return 'discarded' as const;
  }
  try {
    const outcome = await applyResultEffects(delegation, result, resultId, options.executionId);
    if (result.outcome === 'completed') {
      await resolveRuntimeInputs({
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        sourceAgent: delegation.agent,
        resolvedExecutionId: options.executionId,
      });
    }
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
  | { status: 'failed'; resultId: string; taskId: string; storyIndex: number | null; agent: string; reason: string };

const LEGACY_FEEDBACK_PLAN_REJECTION = '反馈新增范围当前不能追加交付单元';

function requeueLegacyFeedbackPlanResultsInDb(
  db: Awaited<ReturnType<typeof databaseConnection>>,
) {
  const rows = db.prepare(`
    SELECT result.result_id, result.execution_id, result.task_id
    FROM agent_results result
    JOIN tasks task ON task.task_id = result.task_id
    WHERE result.agent = 'story-splitter-agent'
      AND result.pipeline = 'feedback-split'
      AND result.application_status = 'failed'
      AND result.application_error = ?
      AND task.agile_status NOT IN ('done', 'cancelled')
  `).all(LEGACY_FEEDBACK_PLAN_REJECTION) as {
    result_id: string;
    execution_id: string | null;
    task_id: string;
  }[];
  if (!rows.length) return 0;

  db.transaction(() => {
    const updateResult = db.prepare(`
      UPDATE agent_results
      SET application_status = 'pending', application_error = NULL,
          applied_at = NULL, effect_outcome = NULL
      WHERE result_id = ?
        AND application_status = 'failed'
        AND application_error = ?
    `);
    const updateExecution = db.prepare(`
      UPDATE execution_attempts
      SET status = 'output_received', last_error = NULL, finished_at = NULL,
          heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ?
    `);
    const updateTask = db.prepare(`
      UPDATE tasks
      SET agile_status = 'in feedback', current_subagent = 'story-splitter-agent',
          run_state = 'runnable', blocked_reason = NULL, resume_status = NULL,
          resume_pending = 0,
          next_step = '检测到旧版反馈交付规划误拒绝，正在重新应用已提交结果',
          last_actor = 'system', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND agile_status NOT IN ('done', 'cancelled')
    `);
    const addRecoveryEvent = db.prepare(`
      INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
      VALUES(?, ?, 'system', 'LegacyFeedbackPlanResultRequeued',
        '恢复旧版本误拒绝的反馈交付规划结果，等待新版本重新应用')
    `);
    const recoveredTasks = new Set<string>();
    for (const row of rows) {
      const updated = updateResult.run(row.result_id, LEGACY_FEEDBACK_PLAN_REJECTION).changes;
      if (!updated) continue;
      if (row.execution_id) updateExecution.run(row.execution_id);
      updateTask.run(row.task_id);
      if (!recoveredTasks.has(row.task_id)) {
        addRecoveryEvent.run(randomUUID(), row.task_id);
        recoveredTasks.add(row.task_id);
      }
    }
  })();
  return rows.length;
}

export async function applyNextQueuedAgentResult(): Promise<QueuedApplicationResult> {
  const db = await databaseConnection();
  requeueLegacyFeedbackPlanResultsInDb(db);
  const row = db.prepare(`
    SELECT ar.result_id, ar.run_id, ar.task_id, ar.story_index, ar.agent, ar.pipeline, ar.outcome, ar.result_json, ar.execution_id
    FROM agent_results ar
    JOIN tasks t ON t.task_id = ar.task_id
    WHERE ar.application_status = 'pending'
      AND t.agile_status != 'blocked'
      AND t.is_paused = 0
    ORDER BY ar.created_at, ar.result_id
    LIMIT 1
  `).get() as QueuedAgentResult | undefined;
  if (!row) return { status: 'none' };

  try {
    const detail = await getTask(row.task_id);
    if (!detail) throw new Error(`需求不存在：${row.task_id}`);
    if (['done', 'cancelled'].includes(detail.task.agile_status)) {
      await markApplication(row.result_id, 'applied', null, 'discarded');
      if (row.execution_id) {
        db.prepare(`
          UPDATE execution_attempts
          SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
          WHERE execution_id = ?
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
    if (result.outcome === 'completed') {
      await resolveRuntimeInputs({
        taskId: row.task_id,
        storyIndex: row.story_index,
        sourceAgent: row.agent,
        resolvedExecutionId: row.execution_id || undefined,
      });
    }
    await markApplication(row.result_id, 'applied', null, outcome);
    const execution = db.prepare('SELECT execution_id FROM agent_results WHERE result_id = ?').get(row.result_id) as { execution_id: string | null } | undefined;
    if (execution?.execution_id) {
      db.prepare(`
        UPDATE execution_attempts
        SET status = 'applied', finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
        WHERE execution_id = ?
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
    return { status: 'failed', resultId: row.result_id, taskId: row.task_id, storyIndex: row.story_index, agent: row.agent, reason };
  }
}
