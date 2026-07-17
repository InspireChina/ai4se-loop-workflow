import { randomUUID } from 'node:crypto';
import { parseAgentResult, type AgentResult } from '../domain/agent-result';
import type { Actor } from '../domain/task';
import { databaseConnection } from '../infrastructure/database';
import {
  addQuestion,
  addStory,
  CodeSlotBusyError,
  getTask,
  rewindTask,
  saveStorySpec,
  updateTask,
  upsertDocument,
  type DelegationEnvelope,
} from './tasks';

const artifactKinds: Record<string, string> = {
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
  if (agent === 'review-agent') return 'review' as const;
  return 'local' as const;
}

async function saveArtifact(delegation: DelegationEnvelope, result: AgentResult) {
  let artifact = result.artifact;
  if (!artifact && delegation.agent === 'backlog-agent') artifact = {
    title: '需求分类与上下文',
    content: `${result.summary}\n\n- 分类：${result.classification || '未确定'}\n- 路由：${result.route || '未确定'}`,
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
};

function envelopeFromTask(row: QueuedAgentResult, detail: NonNullable<Awaited<ReturnType<typeof getTask>>>): DelegationEnvelope {
  const task = detail.task;
  return {
    taskId: row.task_id,
    pipeline: row.pipeline,
    agent: row.agent,
    storyIndex: row.story_index,
    resource: ['backlog-agent', 'repro-agent', 'test-agent'].includes(row.agent) ? 'browser' : 'none',
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

function requireArtifact(result: AgentResult, agent: string) {
  if (!result.artifact) throw new Error(`${agent} 结果缺少 artifact`);
}

async function ensureCodeSlotForDelegation(delegation: DelegationEnvelope, result: AgentResult) {
  if (result.outcome !== 'completed' || delegation.agent !== 'dev-agent') return;
  const db = await databaseConnection();
  const active = db.prepare(`
    SELECT task_id
    FROM tasks
    WHERE task_id != ?
      AND (
        agile_status = 'in dev'
        OR (agile_status = 'blocked' AND resume_status = 'in dev')
      )
    LIMIT 1
  `).get(delegation.taskId) as { task_id: string } | undefined;
  if (active) throw new CodeSlotBusyError(active.task_id);
}

export async function blockDelegation(delegation: DelegationEnvelope, reason: string) {
  await updateTask(delegation.taskId, 'system', {
    agile_status: 'blocked',
    current_subagent: delegation.agent,
    run_state: 'system_blocked',
    blocked_reason: reason,
    next_step: `系统阻塞：${reason}`,
  });
}

type ApplyOutcome = 'advanced' | 'blocked' | 'rewound';

async function applyResultEffects(delegation: DelegationEnvelope, result: AgentResult, sourceResultId?: string): Promise<ApplyOutcome> {
  await ensureCodeSlotForDelegation(delegation, result);
  const artifactDocumentId = await saveArtifact(delegation, result);

  if (result.outcome !== 'completed' && !(delegation.agent === 'analyst-agent' && result.questions.length)) {
    await blockDelegation(delegation, result.summary);
    return 'blocked' as const;
  }
  if (result.questions.length && delegation.agent !== 'analyst-agent') throw new Error(`${delegation.agent} 不允许创建人工澄清问题`);

  const actor = delegation.agent as Actor;
  switch (delegation.agent) {
    case 'backlog-agent': {
      if (!result.classification || !result.route) throw new Error('backlog-agent 结果缺少 classification 或 route');
      await updateTask(delegation.taskId, actor, {
        item_type: result.classification,
        agile_status: result.route === 'repro' ? 'in repro' : 'in plan',
        current_subagent: result.route === 'repro' ? 'repro-agent' : 'story-splitter-agent',
        next_step: result.summary,
      });
      return 'advanced' as const;
    }
    case 'story-splitter-agent': {
      if (!result.deliveryUnits?.length) throw new Error('交付规划 Agent 结果缺少 deliveryUnits');
      const detail = await getTask(delegation.taskId);
      if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
      if (detail.stories.length) throw new Error('当前需求已存在交付单元，拒绝重复拆分');
      for (const unit of result.deliveryUnits) await addStory({ taskId: delegation.taskId, actor, title: unit.title });
      await updateTask(delegation.taskId, actor, {
        agile_status: 'ready for dev',
        current_subagent: 'analyst-agent',
        next_step: `已拆分 ${result.deliveryUnits.length} 个交付单元，等待逐个进行方案分析`,
      });
      return 'advanced' as const;
    }
    case 'analyst-agent': {
      requireArtifact(result, delegation.agent);
      if (!delegation.storyIndex) throw new Error('方案分析 Agent 缺少交付单元序号');
      if (!result.spec) throw new Error('方案分析 Agent 结果缺少结构化 Slice Spec');
      if (result.questions.length) {
        if (!result.spec.ambiguities.length) throw new Error('方案分析 Agent 提问时必须在 Slice Spec 中列出对应歧义');
        const saved = await saveStorySpec({
          taskId: delegation.taskId,
          storyIndex: delegation.storyIndex,
          status: 'waiting_for_answers',
          spec: result.spec,
          sourceResultId,
        });
        await saveQuestions(delegation, result, saved.revision);
        return 'blocked' as const;
      }
      if (result.outcome !== 'completed') throw new Error('没有待澄清问题时，方案分析 Agent 必须完成当前规格');
      await saveStorySpec({
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
          ? `交付单元 ${delegation.storyIndex} 的方案已按人工答复更新`
          : `交付单元 ${delegation.storyIndex} 的方案分析完成，无待确认设计决策`,
      });
      return 'advanced' as const;
    }
    case 'repro-agent': {
      requireArtifact(result, delegation.agent);
      if (result.route !== 'plan') throw new Error('repro-agent 完成后必须 route=plan');
      await updateTask(delegation.taskId, actor, {
        agile_status: 'in plan',
        current_subagent: 'story-splitter-agent',
        next_step: result.summary,
      });
      return 'advanced' as const;
    }
    case 'dev-agent': {
      if (!delegation.storyIndex) throw new Error('开发实现 Agent 缺少交付单元序号');
      await updateTask(delegation.taskId, actor, {
        agile_status: 'in dev',
        current_subagent: 'dev-agent',
        dev_index: delegation.storyIndex,
        next_step: result.summary,
      });
      return 'advanced' as const;
    }
    case 'test-agent': {
      if (!delegation.storyIndex || !result.verdict) throw new Error('验证 Agent 结果缺少交付单元序号或 verdict');
      if (result.verdict === 'passed') {
        const detail = await getTask(delegation.taskId);
        if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
        const complete = delegation.storyIndex === detail.task.total_stories && detail.task.dev_index === detail.task.total_stories && detail.task.analysis_index === detail.task.total_stories;
        await updateTask(delegation.taskId, actor, {
          agile_status: complete ? 'in review' : 'in dev',
          current_subagent: complete ? 'review-agent' : 'test-agent',
          test_index: delegation.storyIndex,
          next_step: result.summary,
        });
        return 'advanced' as const;
      }
      const target = result.rewindTo === 'analysis' ? 'analysis' : 'dev';
      await rewindTask({ taskId: delegation.taskId, actor, to: target, story: result.rewindDeliveryUnit || delegation.storyIndex, reason: result.summary });
      return 'rewound' as const;
    }
    case 'review-agent': {
      requireArtifact(result, delegation.agent);
      if (result.verdict !== 'report_ready') throw new Error('Review Agent 必须返回 verdict=report_ready');
      if (!artifactDocumentId) throw new Error('Review Agent 结卡报告未保存');
      const detail = await getTask(delegation.taskId);
      if (!detail) throw new Error(`需求不存在：${delegation.taskId}`);
      const reviewRevision = detail.task.review_revision + 1;
      await updateTask(delegation.taskId, actor, {
        agile_status: 'ready_to_close',
        current_subagent: null,
        run_state: 'idle',
        closure_status: 'awaiting_read',
        review_revision: reviewRevision,
        review_document_id: artifactDocumentId,
        next_step: `结卡报告 v${reviewRevision} 已生成，等待用户阅读并关闭需求`,
      });
      return 'advanced' as const;
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
  try {
    const outcome = await applyResultEffects(delegation, result, resultId);
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

export async function applyNextQueuedAgentResult(): Promise<QueuedApplicationResult> {
  const db = await databaseConnection();
  const row = db.prepare(`
    SELECT ar.result_id, ar.run_id, ar.task_id, ar.story_index, ar.agent, ar.pipeline, ar.outcome, ar.result_json
    FROM agent_results ar
    JOIN tasks t ON t.task_id = ar.task_id
    WHERE ar.application_status = 'pending'
      AND t.agile_status NOT IN ('blocked', 'done', 'cancelled')
    ORDER BY ar.created_at, ar.result_id
    LIMIT 1
  `).get() as QueuedAgentResult | undefined;
  if (!row) return { status: 'none' };

  try {
    const detail = await getTask(row.task_id);
    if (!detail) throw new Error(`需求不存在：${row.task_id}`);
    const result = parseAgentResult(row.result_json);
    const delegation = envelopeFromTask(row, detail);
    const outcome = await applyResultEffects(delegation, result, row.result_id);
    await markApplication(row.result_id, 'applied');
    const execution = db.prepare('SELECT execution_id FROM agent_results WHERE result_id = ?').get(row.result_id) as { execution_id: string | null } | undefined;
    if (execution?.execution_id) {
      db.prepare(`
        UPDATE execution_attempts
        SET status = 'applied', finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP,
            lease_expires_at = NULL
        WHERE execution_id = ?
      `).run(execution.execution_id);
      db.prepare(`
        INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
        VALUES(?, ?, 'application', ?, ?)
        ON CONFLICT(execution_id, kind, receipt_key) DO NOTHING
      `).run(randomUUID(), execution.execution_id, outcome, JSON.stringify({ outcome, source: 'application_queue' }));
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
