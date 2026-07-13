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
  updateTask,
  upsertDocument,
  type DelegationEnvelope,
} from './tasks';

const artifactKinds: Record<string, string> = {
  'backlog-agent': 'context',
  'story-splitter-agent': 'story_split',
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
    title: 'Task 分类与上下文',
    content: `${result.summary}\n\n- 分类：${result.classification || '未确定'}\n- 路由：${result.route || '未确定'}`,
  };
  if (!artifact && delegation.agent === 'story-splitter-agent' && result.stories?.length) artifact = {
    title: 'Story 拆分',
    content: result.stories.map((story, index) => `${index + 1}. ${story.title}`).join('\n'),
  };
  if (!artifact && delegation.agent === 'dev-agent') artifact = {
    title: `Story-${delegation.storyIndex} 开发结果`,
    content: [result.summary, ...(result.tests || []).map((test) => `- ${test.passed ? '通过' : '失败'}：${test.command}${test.summary ? ` — ${test.summary}` : ''}`)].join('\n\n'),
  };
  if (!artifact && delegation.agent === 'test-agent') artifact = {
    title: `Story-${delegation.storyIndex} 测试结果`,
    content: [`结论：${result.verdict || result.outcome}`, result.summary, ...(result.tests || []).map((test) => `- ${test.passed ? '通过' : '失败'}：${test.command}${test.summary ? ` — ${test.summary}` : ''}`)].join('\n\n'),
  };
  if (!artifact) return;
  await upsertDocument({
    taskId: delegation.taskId,
    storyIndex: delegation.storyIndex,
    actor: delegation.agent,
    kind: artifactKinds[delegation.agent] || 'context',
    title: artifact.title,
    content: artifact.content,
    format: 'markdown',
  });
}

async function saveQuestions(delegation: DelegationEnvelope, result: AgentResult) {
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
      blockedReason: draft.title,
      blockTask: true,
    });
  }
}

async function recordResult(runId: string, delegation: DelegationEnvelope, result: AgentResult, codeCommit?: string) {
  const db = await databaseConnection();
  const resultId = randomUUID();
  db.prepare(`
    INSERT INTO agent_results(result_id, run_id, task_id, story_index, agent, pipeline, outcome, result_json, application_status, code_commit)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(resultId, runId, delegation.taskId, delegation.storyIndex, delegation.agent, delegation.pipeline, result.outcome, JSON.stringify(result), codeCommit || null);
  return resultId;
}

async function markApplication(resultId: string, status: 'pending' | 'applied' | 'failed', error?: string | null) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE agent_results
    SET application_status = ?,
        application_error = ?,
        applied_at = CASE WHEN ? = 'applied' THEN CURRENT_TIMESTAMP ELSE applied_at END
    WHERE result_id = ?
  `).run(status, error || null, status, resultId);
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
    itemType: task.item_type,
    priority: task.priority || '',
    link: task.link || '',
    externalId: task.external_id || '',
    externalStatus: task.external_status || '',
    agileStatus: task.agile_status,
    currentSubagent: task.current_subagent || '',
    resumePending: task.resume_pending,
    analysisApprovedIndex: task.analysis_approved_index,
    reviewApproved: task.review_approved,
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
  if (result.outcome !== 'completed' || !['dev-agent', 'review-agent'].includes(delegation.agent)) return;
  const db = await databaseConnection();
  const active = db.prepare(`
    SELECT task_id
    FROM tasks
    WHERE task_id != ?
      AND (
        agile_status IN ('in dev', 'in review')
        OR (agile_status = 'blocked' AND resume_status IN ('in dev', 'in review'))
        OR (agile_status = 'blocked' AND current_subagent = 'review-agent')
      )
    LIMIT 1
  `).get(delegation.taskId) as { task_id: string } | undefined;
  if (active) throw new CodeSlotBusyError(active.task_id);
}

export async function blockDelegation(delegation: DelegationEnvelope, reason: string) {
  await saveQuestions(delegation, { outcome: 'needs_input', summary: reason, questions: [] });
}

type ApplyOutcome = 'advanced' | 'blocked' | 'rewound';

async function applyResultEffects(delegation: DelegationEnvelope, result: AgentResult): Promise<ApplyOutcome> {
  await ensureCodeSlotForDelegation(delegation, result);
  await saveArtifact(delegation, result);

  if (result.outcome !== 'completed' || (result.questions.length > 0 && delegation.agent !== 'analyst-agent' && delegation.agent !== 'review-agent')) {
    await saveQuestions(delegation, result);
    return 'blocked' as const;
  }

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
      if (!result.stories?.length) throw new Error('story-splitter-agent 结果缺少 stories');
      const detail = await getTask(delegation.taskId);
      if (!detail) throw new Error(`task not found: ${delegation.taskId}`);
      if (detail.stories.length) throw new Error('当前 Task 已存在 Story，拒绝重复拆分');
      for (const story of result.stories) await addStory({ taskId: delegation.taskId, actor, title: story.title });
      await updateTask(delegation.taskId, actor, {
        agile_status: 'ready for dev',
        current_subagent: 'analyst-agent',
        next_step: `已拆分 ${result.stories.length} 个 Story，等待逐个分析`,
      });
      return 'advanced' as const;
    }
    case 'analyst-agent': {
      requireArtifact(result, delegation.agent);
      if (!delegation.storyIndex) throw new Error('analyst-agent 缺少 storyIndex');
      if (result.questions.length) {
        await saveQuestions(delegation, result);
        return 'blocked' as const;
      }
      await updateTask(delegation.taskId, actor, {
        analysis_index: delegation.storyIndex,
        analysis_approved_index: delegation.storyIndex,
        next_step: delegation.pipeline === 'resume'
          ? `Story-${delegation.storyIndex} 分析已按人工答复更新`
          : `Story-${delegation.storyIndex} 分析完成，无待确认设计决策`,
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
      if (!delegation.storyIndex) throw new Error('dev-agent 缺少 storyIndex');
      await updateTask(delegation.taskId, actor, {
        agile_status: 'in dev',
        current_subagent: 'dev-agent',
        dev_index: delegation.storyIndex,
        next_step: result.summary,
      });
      return 'advanced' as const;
    }
    case 'test-agent': {
      if (!delegation.storyIndex || !result.verdict) throw new Error('test-agent 结果缺少 storyIndex 或 verdict');
      if (result.verdict === 'passed') {
        const detail = await getTask(delegation.taskId);
        if (!detail) throw new Error(`task not found: ${delegation.taskId}`);
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
      await rewindTask({ taskId: delegation.taskId, actor, to: target, story: result.rewindStory || delegation.storyIndex, reason: result.summary });
      return 'rewound' as const;
    }
    case 'review-agent': {
      requireArtifact(result, delegation.agent);
      if (result.verdict === 'changes_requested') {
        if (!result.rewindTo) throw new Error('review-agent 要求修改时必须给出 rewindTo');
        await rewindTask({ taskId: delegation.taskId, actor, to: result.rewindTo, story: result.rewindStory, reason: result.summary });
        return 'rewound' as const;
      }
      if (result.verdict !== 'ready_for_approval') throw new Error('review-agent 结果缺少有效 verdict');
      if (delegation.pipeline === 'resume') {
        await updateTask(delegation.taskId, actor, {
          agile_status: 'done',
          current_subagent: null,
          next_step: result.summary,
        });
        return 'advanced' as const;
      }
      if (result.questions.length) await saveQuestions(delegation, result);
      await addQuestion({
        taskId: delegation.taskId,
        actor,
        kind: 'review',
        title: '确认 Task 最终交付',
        question: '请确认当前 Task 的实现与验证结果是否可以完成交付。',
        why: 'Task 完成需要最终人工批准。',
        recommendation: '确认交付后完成 Task。',
        blockedReason: '等待最终交付批准',
        blockTask: true,
      });
      return 'blocked' as const;
    }
    default:
      throw new Error(`不支持的 agent：${delegation.agent}`);
  }
}

export async function applyAgentResult(runId: string, delegation: DelegationEnvelope, result: AgentResult, options: { codeCommit?: string } = {}) {
  const resultId = await recordResult(runId, delegation, result, options.codeCommit);
  try {
    const outcome = await applyResultEffects(delegation, result);
    await markApplication(resultId, 'applied');
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
    if (!detail) throw new Error(`task not found: ${row.task_id}`);
    const result = parseAgentResult(row.result_json);
    const delegation = envelopeFromTask(row, detail);
    const outcome = await applyResultEffects(delegation, result);
    await markApplication(row.result_id, 'applied');
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
