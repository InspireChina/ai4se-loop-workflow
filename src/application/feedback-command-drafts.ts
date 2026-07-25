import { agentResultSchema } from '../domain/agent-result';
import { databaseConnection } from '../infrastructure/database';

type Db = Awaited<ReturnType<typeof databaseConnection>>;
type FlagMap = Map<string, string>;

export type FeedbackDraftRow = {
  draft_id: string;
  work_key: string;
  draft_version: number;
  task_id: string;
  status: 'editing' | 'waiting_for_answers' | 'submitted' | 'abandoned';
  change_seq: number;
  status_viewed_execution_id: string | null;
  terminal_execution_id: string | null;
  terminal_action: string | null;
};

export type FeedbackExecutionRow = {
  execution_id: string;
  task_id: string;
  pipeline: string;
  input_json: string;
};

type FeedbackWorkType =
  | 'reply'
  | 'historical_correction'
  | 'report_correction'
  | 'bug'
  | 'behavior_change'
  | 'scope_addition'
  | 'technical_change'
  | 'learning_only';

function required(flags: FlagMap, name: string) {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

function bounded(value: string, label: string, max = 4000) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return normalized;
}

function positiveInteger(flags: FlagMap, name: string) {
  const value = required(flags, name);
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`--${name} 必须是正整数`);
  return Number(value);
}

function nextOrdinal(db: Db, table: string, draftId: string, extra?: {
  column: string;
  value: string;
}) {
  const where = extra ? ` AND ${extra.column} = ?` : '';
  const params = extra ? [draftId, extra.value] : [draftId];
  return (db.prepare(`
    SELECT COALESCE(MAX(ordinal), 0) + 1 AS value
    FROM ${table} WHERE draft_id = ?${where}
  `).get(...params) as { value: number }).value;
}

function touchDraft(db: Db, draftId: string) {
  db.prepare(`
    UPDATE agent_work_drafts
    SET change_seq = change_seq + 1, updated_at = CURRENT_TIMESTAMP
    WHERE draft_id = ?
  `).run(draftId);
}

function assertViewed(draft: FeedbackDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 feedback status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function executionContext(execution: FeedbackExecutionRow) {
  try {
    const parsed = JSON.parse(execution.input_json) as {
      delegation?: {
        feedbackBatchId?: string | null;
        feedbackGroupId?: string | null;
        feedbackId?: string | null;
        feedbackIds?: string[] | null;
      };
    };
    return {
      batchId: parsed.delegation?.feedbackBatchId || null,
      groupId: parsed.delegation?.feedbackGroupId || null,
      commentId: parsed.delegation?.feedbackId || null,
      commentIds: parsed.delegation?.feedbackIds || [],
    };
  } catch {
    return { batchId: null, groupId: null, commentId: null, commentIds: [] as string[] };
  }
}

function state(db: Db, draft: FeedbackDraftRow, execution: FeedbackExecutionRow) {
  const header = db.prepare(`
    SELECT mode, summary, verification_reason
    FROM feedback_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    mode: 'triage' | 'verify';
    summary: string | null;
    verification_reason: string | null;
  };
  const groups = db.prepare(`
    SELECT group_key, work_type, title, reason, response, ordinal
    FROM feedback_draft_groups
    WHERE draft_id = ? ORDER BY ordinal, group_key
  `).all(draft.draft_id) as {
    group_key: string;
    work_type: FeedbackWorkType;
    title: string | null;
    reason: string;
    response: string | null;
    ordinal: number;
  }[];
  const comments = db.prepare(`
    SELECT group_key, comment_id, ordinal
    FROM feedback_draft_group_comments
    WHERE draft_id = ? ORDER BY ordinal, comment_id
  `).all(draft.draft_id) as { group_key: string; comment_id: string; ordinal: number }[];
  const units = db.prepare(`
    SELECT group_key, story_index, ordinal
    FROM feedback_draft_group_units
    WHERE draft_id = ? ORDER BY ordinal, story_index
  `).all(draft.draft_id) as { group_key: string; story_index: number; ordinal: number }[];
  const acceptance = db.prepare(`
    SELECT group_key, acceptance_key, content, ordinal
    FROM feedback_draft_acceptance
    WHERE draft_id = ? ORDER BY ordinal, acceptance_key
  `).all(draft.draft_id) as {
    group_key: string;
    acceptance_key: string;
    content: string;
    ordinal: number;
  }[];
  const questions = db.prepare(`
    SELECT decision_key, title, question, impact,
           recommendation_option_id, recommendation_reason, ordinal
    FROM feedback_draft_questions
    WHERE draft_id = ? ORDER BY ordinal, decision_key
  `).all(draft.draft_id) as {
    decision_key: string;
    title: string;
    question: string;
    impact: string;
    recommendation_option_id: string | null;
    recommendation_reason: string | null;
    ordinal: number;
  }[];
  const options = db.prepare(`
    SELECT decision_key, option_id, label, consequence, ordinal
    FROM feedback_draft_question_options
    WHERE draft_id = ? ORDER BY ordinal, option_id
  `).all(draft.draft_id) as {
    decision_key: string;
    option_id: string;
    label: string;
    consequence: string;
    ordinal: number;
  }[];
  const answerRows = db.prepare(`
    SELECT decision_key, answer, status
    FROM questions
    WHERE task_id = ? AND source_agent = 'feedback-agent'
      AND decision_key IS NOT NULL
      AND created_at >= (
        SELECT MIN(created_at) FROM agent_work_drafts WHERE work_key = ?
      )
    ORDER BY created_at, question_id
  `).all(draft.task_id, draft.work_key) as {
    decision_key: string;
    answer: string | null;
    status: string;
  }[];
  const answers = new Map(answerRows.map((row) => [row.decision_key, row]));
  const evidence = db.prepare(`
    SELECT evidence_key, content, ordinal
    FROM feedback_draft_evidence
    WHERE draft_id = ? ORDER BY ordinal, evidence_key
  `).all(draft.draft_id) as {
    evidence_key: string;
    content: string;
    ordinal: number;
  }[];
  const context = executionContext(execution);
  const batchCommentIds = context.batchId
    ? (db.prepare(`
        SELECT comment_id FROM feedback_batch_comments
        WHERE batch_id = ? ORDER BY ordinal, comment_id
      `).all(context.batchId) as { comment_id: string }[]).map((row) => row.comment_id)
    : context.commentIds;
  const task = db.prepare(`
    SELECT total_stories FROM tasks WHERE task_id = ?
  `).get(draft.task_id) as { total_stories: number } | undefined;
  return {
    header,
    groups: groups.map((group) => ({
      ...group,
      commentIds: comments.filter((item) => item.group_key === group.group_key).map((item) => item.comment_id),
      affectedDeliveryUnits: units.filter((item) => item.group_key === group.group_key).map((item) => item.story_index),
      acceptance: acceptance.filter((item) => item.group_key === group.group_key),
    })),
    questions: questions.map((question) => ({
      ...question,
      options: options.filter((option) => option.decision_key === question.decision_key),
      answer: answers.get(question.decision_key)?.answer || null,
    })),
    evidence,
    context,
    expectedCommentIds: batchCommentIds,
    totalStories: task?.total_stories || 0,
  };
}

type FeedbackState = ReturnType<typeof state>;
type TerminalAction = 'triage-complete' | 'request-clarification' | 'resolve' | 'reopen';

function questionErrors(current: FeedbackState) {
  const errors: string[] = [];
  for (const question of current.questions) {
    if (question.answer) continue;
    if (question.options.length < 2) errors.push(`问题 ${question.decision_key} 至少需要两个互斥选项`);
    if (!question.recommendation_option_id) errors.push(`问题 ${question.decision_key} 缺少推荐选项`);
    else if (!question.options.some((option) => option.option_id === question.recommendation_option_id)) {
      errors.push(`问题 ${question.decision_key} 的推荐选项不存在`);
    }
    if (!question.recommendation_reason?.trim()) errors.push(`问题 ${question.decision_key} 缺少推荐理由`);
  }
  return errors;
}

function triageErrors(current: FeedbackState, terminal: TerminalAction | null) {
  const errors = questionErrors(current);
  const expected = new Set(current.expectedCommentIds);
  const seen = new Set<string>();
  for (const group of current.groups) {
    if (!group.commentIds.length) errors.push(`反馈分组 ${group.group_key} 至少需要一条评论`);
    for (const commentId of group.commentIds) {
      if (!expected.has(commentId)) errors.push(`反馈分组 ${group.group_key} 引用了批次外评论：${commentId}`);
      if (seen.has(commentId)) errors.push(`反馈评论被多个分组重复引用：${commentId}`);
      seen.add(commentId);
    }
    if (['behavior_change', 'bug', 'scope_addition', 'technical_change', 'report_correction'].includes(group.work_type)) {
      if (!group.title?.trim()) errors.push(`反馈分组 ${group.group_key} 缺少标题`);
      if (!group.acceptance.length) errors.push(`反馈分组 ${group.group_key} 缺少可验证验收条件`);
    }
    if (['reply', 'historical_correction'].includes(group.work_type) && !group.response?.trim()) {
      errors.push(`反馈分组 ${group.group_key} 缺少明确回复`);
    }
    const invalidUnits = group.affectedDeliveryUnits.filter((index) =>
      index < 1 || index > current.totalStories);
    if (invalidUnits.length) {
      errors.push(`反馈分组 ${group.group_key} 引用了不存在的交付单元：${invalidUnits.join(', ')}`);
    }
  }
  if (terminal === 'triage-complete') {
    if (!current.groups.length) errors.push('反馈分流至少需要一个工作组');
    const missing = current.expectedCommentIds.filter((commentId) => !seen.has(commentId));
    if (missing.length) errors.push(`反馈分流遗漏评论：${missing.join(', ')}`);
    const unanswered = current.questions.filter((question) => !question.answer);
    if (unanswered.length) errors.push(`仍有 ${unanswered.length} 个未回答问题，不能完成反馈分流`);
  }
  if (terminal === 'request-clarification'
    && !current.questions.some((question) => !question.answer)) {
    errors.push('没有待用户回答的问题，不能请求澄清');
  }
  return errors;
}

function validationErrors(current: FeedbackState, terminal: TerminalAction | null = null) {
  const errors: string[] = [];
  if (!current.header.summary?.trim()) errors.push('缺少反馈处理摘要');
  if (current.header.mode === 'triage') {
    if (terminal === 'resolve' || terminal === 'reopen') errors.push('Triage 草稿不能提交 Verify 结论');
    errors.push(...triageErrors(current, terminal));
  } else {
    if (terminal === 'triage-complete' || terminal === 'request-clarification') {
      errors.push('Verify 草稿不能提交 Triage 结论或澄清问题');
    }
    if (!current.context.commentId) errors.push('当前 Verify execution 缺少目标评论');
    if ((terminal === 'resolve' || terminal === 'reopen') && !current.header.verification_reason?.trim()) {
      errors.push('缺少反馈验证理由');
    }
    if ((terminal === 'resolve' || terminal === 'reopen') && !current.evidence.length) {
      errors.push('反馈验证至少需要一条独立证据');
    }
  }
  return [...new Set(errors)];
}

function renderStatus(draft: FeedbackDraftRow, current: FeedbackState) {
  const lines = [
    `反馈草稿 v${draft.draft_version} · ${current.header.mode === 'triage' ? '批次分流' : '独立验证'} · 变更 ${draft.change_seq}`,
    '',
    `处理摘要：${current.header.summary || '未填写'}`,
  ];
  if (current.header.mode === 'triage') {
    lines.push(
      `批次：${current.context.batchId || '未知'}`,
      `冻结评论：${current.expectedCommentIds.length}`,
      `工作组：${current.groups.length}`,
      `澄清问题：${current.questions.length}（已回答 ${current.questions.filter((item) => item.answer).length}）`,
    );
    if (current.expectedCommentIds.length) {
      lines.push('', '冻结评论 ID：', ...current.expectedCommentIds.map((id) => `- ${id}`));
    }
    if (current.groups.length) {
      lines.push('', '工作组（跨轮次必须复用 group key）：');
      for (const group of current.groups) {
        lines.push(
          `- ${group.group_key} · ${group.work_type} · ${group.title || '无标题'}`,
          `  评论：${group.commentIds.join(', ') || '未关联'}`,
          `  影响单元：${group.affectedDeliveryUnits.join(', ') || '无'}`,
          `  验收：${group.acceptance.map((item) => `${item.acceptance_key}=${item.content}`).join('；') || '无'}`,
        );
      }
    }
    if (current.questions.length) {
      lines.push('', '澄清问题（decision key 跨轮次不可改名）：');
      for (const question of current.questions) {
        lines.push(`- ${question.decision_key}：${question.title} · ${question.answer ? `已回答=${question.answer}` : '待回答'}`);
      }
    }
  } else {
    lines.push(
      `目标评论：${current.context.commentId || '未知'}`,
      `工作组：${current.context.groupId || '未知'}`,
      `验证理由：${current.header.verification_reason || '未填写'}`,
      `独立证据：${current.evidence.length}`,
    );
    if (current.evidence.length) {
      lines.push('', '证据（跨轮次必须复用 evidence key）：');
      for (const item of current.evidence) lines.push(`- ${item.evidence_key}：${item.content}`);
    }
  }
  const errors = validationErrors(current);
  if (errors.length) {
    lines.push('', '当前校验提示：', ...errors.map((item, index) => `${index + 1}. ${item}`));
  } else {
    lines.push('', '草稿基础结构已建立；请按当前模式选择终止命令。');
  }
  return lines.join('\n');
}

function buildQuestions(current: FeedbackState) {
  return current.questions.filter((question) => !question.answer).map((question) => {
    const recommended = question.options.find((option) =>
      option.option_id === question.recommendation_option_id)!;
    return {
      decisionKey: question.decision_key,
      title: question.title,
      question: question.question,
      why: question.impact,
      recommendation: recommended.label,
      recommendationReason: question.recommendation_reason!,
      alternatives: question.options.map((option) => ({
        id: option.option_id,
        label: option.label,
        consequences: [option.consequence],
      })),
      dependsOn: [],
    };
  });
}

function buildResult(current: FeedbackState, action: TerminalAction) {
  if (action === 'request-clarification') {
    const questions = buildQuestions(current);
    return agentResultSchema.parse({
      outcome: 'needs_input',
      summary: current.header.summary,
      questions,
    });
  }
  if (action === 'triage-complete') {
    return agentResultSchema.parse({
      outcome: 'completed',
      summary: current.header.summary,
      feedback: {
        mode: 'triage',
        groups: current.groups.map((group) => ({
          groupKey: group.group_key,
          commentIds: group.commentIds,
          workType: group.work_type,
          ...(group.title ? { title: group.title } : {}),
          affectedDeliveryUnits: group.affectedDeliveryUnits,
          reason: group.reason,
          acceptance: group.acceptance.map((item) => item.content),
          ...(group.response ? { response: group.response } : {}),
        })),
      },
    });
  }
  return agentResultSchema.parse({
    outcome: 'completed',
    summary: current.header.summary,
    feedback: {
      mode: 'verify',
      commentId: current.context.commentId,
      verdict: action === 'resolve' ? 'resolved' : 'reopened',
      reason: current.header.verification_reason,
      evidence: current.evidence.map((item) => item.content),
    },
  });
}

function terminalSubmit(
  db: Db,
  draft: FeedbackDraftRow,
  execution: FeedbackExecutionRow,
  action: TerminalAction,
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft, execution);
  const errors = validationErrors(current, action);
  if (errors.length) {
    throw new Error(`反馈草稿不能执行 ${action}：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  const result = buildResult(current, action);
  const status = action === 'request-clarification' ? 'waiting_for_answers' : 'submitted';
  db.transaction(() => {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status = ?, terminal_action = ?, terminal_execution_id = ?,
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(status, action, execution.execution_id, draft.draft_id);
    db.prepare(`
      UPDATE execution_attempts
      SET result_json = ?, status = 'output_received', heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ?
    `).run(JSON.stringify(result), execution.execution_id);
  })();
  return action === 'triage-complete'
    ? '反馈批次分流结果已提交。'
    : action === 'request-clarification'
      ? '反馈澄清问题已提交，等待用户回答。'
      : action === 'resolve'
        ? '反馈已满足的验证结论已提交。'
        : '反馈未满足的验证结论已提交，将形成新的前向批次。';
}

export function feedbackHelp(terminalActions: string[]) {
  return [
    '  feedback status',
    '  feedback summary set --text <处理摘要>',
    '',
    'Triage 草稿：',
    '  feedback group upsert --key <稳定 key> --type <reply|historical_correction|report_correction|bug|behavior_change|scope_addition|technical_change|learning_only> --reason <判断理由> [--title <标题>]',
    '  feedback group remove --key <稳定 key>',
    '  feedback group comment add|remove --key <group key> --id <批次评论 id>',
    '  feedback group unit add|remove --key <group key> --index <既有交付单元序号>',
    '  feedback group acceptance upsert --key <group key> --acceptance-key <稳定 key> --text <客观验收条件>',
    '  feedback group acceptance remove --key <group key> --acceptance-key <稳定 key>',
    '  feedback group response set --key <group key> --text <直接回复或历史更正说明>',
    '  feedback group response clear --key <group key>',
    '  feedback question upsert --key <稳定 decision key> --title <标题> --question <问题> --impact <影响>',
    '  feedback question option-upsert --key <decision key> --id <选项 id> --label <名称> --consequence <后果>',
    '  feedback question option-remove --key <decision key> --id <选项 id>',
    '  feedback question recommend --key <decision key> --option <选项 id> --reason <理由>',
    '  feedback question remove --key <decision key>',
    '',
    'Verify 草稿：',
    '  feedback verification reason set --text <验证理由>',
    '  feedback evidence upsert --key <稳定 key> --text <独立证据>',
    '  feedback evidence remove --key <稳定 key>',
    '',
    '终止命令：',
    ...terminalActions.map((action) => `  ${action}`),
  ];
}

function assertMode(current: FeedbackState, mode: 'triage' | 'verify') {
  if (current.header.mode !== mode) {
    throw new Error(`当前是 ${current.header.mode} 草稿，不能执行 ${mode} 命令`);
  }
}

function assertGroup(db: Db, draftId: string, groupKey: string) {
  const row = db.prepare(`
    SELECT 1 FROM feedback_draft_groups WHERE draft_id = ? AND group_key = ?
  `).get(draftId, groupKey);
  if (!row) throw new Error(`反馈分组不存在：${groupKey}`);
}

export function runFeedbackCommand(input: {
  db: Db;
  execution: FeedbackExecutionRow;
  draft: FeedbackDraftRow;
  command: string;
  flags: FlagMap;
}) {
  const { db, execution, draft, command, flags } = input;
  if (command === 'feedback status') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    return renderStatus(
      { ...draft, status_viewed_execution_id: execution.execution_id },
      state(db, draft, execution),
    );
  }
  if (
    ['feedback triage-complete', 'feedback request-clarification', 'feedback resolve', 'feedback reopen'].includes(command)
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === command.replace('feedback ', '')
  ) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft, execution);

  if (command === 'feedback summary set') {
    db.prepare('UPDATE feedback_drafts SET summary = ? WHERE draft_id = ?')
      .run(bounded(required(flags, 'text'), '处理摘要', 10000), draft.draft_id);
    touchDraft(db, draft.draft_id);
    return '反馈处理摘要已保存。';
  }
  if (command === 'feedback group upsert') {
    assertMode(current, 'triage');
    const key = bounded(required(flags, 'key'), '分组 key', 200);
    const workType = required(flags, 'type') as FeedbackWorkType;
    const allowed: FeedbackWorkType[] = [
      'reply', 'historical_correction', 'report_correction', 'bug',
      'behavior_change', 'scope_addition', 'technical_change', 'learning_only',
    ];
    if (!allowed.includes(workType)) throw new Error(`不支持的反馈工作类型：${workType}`);
    const title = flags.get('title')?.trim() || null;
    if (title && title.length > 240) throw new Error('分组标题不能超过 240 个字符');
    const ordinal = nextOrdinal(db, 'feedback_draft_groups', draft.draft_id);
    db.prepare(`
      INSERT INTO feedback_draft_groups(
        draft_id, group_key, work_type, title, reason, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, group_key) DO UPDATE SET
        work_type = excluded.work_type, title = excluded.title, reason = excluded.reason
    `).run(
      draft.draft_id,
      key,
      workType,
      title,
      bounded(required(flags, 'reason'), '分组理由'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `反馈分组 ${key} 已保存。`;
  }
  if (command === 'feedback group remove') {
    assertMode(current, 'triage');
    db.prepare('DELETE FROM feedback_draft_groups WHERE draft_id = ? AND group_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '反馈分组已删除。';
  }
  if (command === 'feedback group comment add' || command === 'feedback group comment remove') {
    assertMode(current, 'triage');
    const groupKey = required(flags, 'key');
    const commentId = bounded(required(flags, 'id'), '评论 id', 200);
    assertGroup(db, draft.draft_id, groupKey);
    if (command.endsWith(' add')) {
      if (!current.expectedCommentIds.includes(commentId)) throw new Error(`评论不属于当前冻结批次：${commentId}`);
      const owner = db.prepare(`
        SELECT group_key FROM feedback_draft_group_comments
        WHERE draft_id = ? AND comment_id = ? AND group_key != ?
      `).get(draft.draft_id, commentId, groupKey) as { group_key: string } | undefined;
      if (owner) throw new Error(`评论 ${commentId} 已属于分组 ${owner.group_key}`);
      const ordinal = nextOrdinal(db, 'feedback_draft_group_comments', draft.draft_id, {
        column: 'group_key',
        value: groupKey,
      });
      db.prepare(`
        INSERT INTO feedback_draft_group_comments(draft_id, group_key, comment_id, ordinal)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(draft_id, group_key, comment_id) DO NOTHING
      `).run(draft.draft_id, groupKey, commentId, ordinal);
    } else {
      db.prepare(`
        DELETE FROM feedback_draft_group_comments
        WHERE draft_id = ? AND group_key = ? AND comment_id = ?
      `).run(draft.draft_id, groupKey, commentId);
    }
    touchDraft(db, draft.draft_id);
    return `反馈分组 ${groupKey} 的评论关联已更新。`;
  }
  if (command === 'feedback group unit add' || command === 'feedback group unit remove') {
    assertMode(current, 'triage');
    const groupKey = required(flags, 'key');
    const storyIndex = positiveInteger(flags, 'index');
    assertGroup(db, draft.draft_id, groupKey);
    if (storyIndex > current.totalStories) throw new Error(`交付单元 ${storyIndex} 不存在`);
    if (command.endsWith(' add')) {
      const ordinal = nextOrdinal(db, 'feedback_draft_group_units', draft.draft_id, {
        column: 'group_key',
        value: groupKey,
      });
      db.prepare(`
        INSERT INTO feedback_draft_group_units(draft_id, group_key, story_index, ordinal)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(draft_id, group_key, story_index) DO NOTHING
      `).run(draft.draft_id, groupKey, storyIndex, ordinal);
    } else {
      db.prepare(`
        DELETE FROM feedback_draft_group_units
        WHERE draft_id = ? AND group_key = ? AND story_index = ?
      `).run(draft.draft_id, groupKey, storyIndex);
    }
    touchDraft(db, draft.draft_id);
    return `反馈分组 ${groupKey} 的影响单元已更新。`;
  }
  if (command === 'feedback group acceptance upsert') {
    assertMode(current, 'triage');
    const groupKey = required(flags, 'key');
    const acceptanceKey = bounded(required(flags, 'acceptance-key'), '验收 key', 120);
    assertGroup(db, draft.draft_id, groupKey);
    const ordinal = nextOrdinal(db, 'feedback_draft_acceptance', draft.draft_id, {
      column: 'group_key',
      value: groupKey,
    });
    db.prepare(`
      INSERT INTO feedback_draft_acceptance(
        draft_id, group_key, acceptance_key, content, ordinal
      ) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, group_key, acceptance_key) DO UPDATE SET
        content = excluded.content
    `).run(
      draft.draft_id,
      groupKey,
      acceptanceKey,
      bounded(required(flags, 'text'), '验收条件', 2000),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `反馈分组 ${groupKey} 的验收条件 ${acceptanceKey} 已保存。`;
  }
  if (command === 'feedback group acceptance remove') {
    assertMode(current, 'triage');
    db.prepare(`
      DELETE FROM feedback_draft_acceptance
      WHERE draft_id = ? AND group_key = ? AND acceptance_key = ?
    `).run(draft.draft_id, required(flags, 'key'), required(flags, 'acceptance-key'));
    touchDraft(db, draft.draft_id);
    return '反馈验收条件已删除。';
  }
  if (command === 'feedback group response set') {
    assertMode(current, 'triage');
    const groupKey = required(flags, 'key');
    assertGroup(db, draft.draft_id, groupKey);
    db.prepare(`
      UPDATE feedback_draft_groups SET response = ?
      WHERE draft_id = ? AND group_key = ?
    `).run(bounded(required(flags, 'text'), '反馈回复'), draft.draft_id, groupKey);
    touchDraft(db, draft.draft_id);
    return `反馈分组 ${groupKey} 的回复已保存。`;
  }
  if (command === 'feedback group response clear') {
    assertMode(current, 'triage');
    db.prepare(`
      UPDATE feedback_draft_groups SET response = NULL
      WHERE draft_id = ? AND group_key = ?
    `).run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '反馈分组回复已清除。';
  }
  if (command === 'feedback question upsert') {
    assertMode(current, 'triage');
    const key = bounded(required(flags, 'key'), 'decision key', 240);
    const ordinal = nextOrdinal(db, 'feedback_draft_questions', draft.draft_id);
    db.prepare(`
      INSERT INTO feedback_draft_questions(
        draft_id, decision_key, title, question, impact, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, decision_key) DO UPDATE SET
        title = excluded.title, question = excluded.question, impact = excluded.impact
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'title'), '问题标题', 200),
      bounded(required(flags, 'question'), '问题'),
      bounded(required(flags, 'impact'), '问题影响', 1000),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `反馈澄清问题 ${key} 已保存。`;
  }
  if (command === 'feedback question option-upsert') {
    assertMode(current, 'triage');
    const key = required(flags, 'key');
    const exists = db.prepare(`
      SELECT 1 FROM feedback_draft_questions WHERE draft_id = ? AND decision_key = ?
    `).get(draft.draft_id, key);
    if (!exists) throw new Error(`反馈澄清问题不存在：${key}`);
    const optionId = bounded(required(flags, 'id'), '选项 id', 100);
    const ordinal = nextOrdinal(db, 'feedback_draft_question_options', draft.draft_id, {
      column: 'decision_key',
      value: key,
    });
    db.prepare(`
      INSERT INTO feedback_draft_question_options(
        draft_id, decision_key, option_id, label, consequence, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, decision_key, option_id) DO UPDATE SET
        label = excluded.label, consequence = excluded.consequence
    `).run(
      draft.draft_id,
      key,
      optionId,
      bounded(required(flags, 'label'), '选项名称', 240),
      bounded(required(flags, 'consequence'), '选项后果', 1000),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `反馈澄清问题 ${key} 的选项 ${optionId} 已保存。`;
  }
  if (command === 'feedback question option-remove') {
    assertMode(current, 'triage');
    db.prepare(`
      DELETE FROM feedback_draft_question_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).run(draft.draft_id, required(flags, 'key'), required(flags, 'id'));
    touchDraft(db, draft.draft_id);
    return '反馈澄清选项已删除。';
  }
  if (command === 'feedback question recommend') {
    assertMode(current, 'triage');
    const key = required(flags, 'key');
    const optionId = required(flags, 'option');
    const exists = db.prepare(`
      SELECT 1 FROM feedback_draft_question_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).get(draft.draft_id, key, optionId);
    if (!exists) throw new Error(`问题 ${key} 不存在选项 ${optionId}`);
    db.prepare(`
      UPDATE feedback_draft_questions
      SET recommendation_option_id = ?, recommendation_reason = ?
      WHERE draft_id = ? AND decision_key = ?
    `).run(
      optionId,
      bounded(required(flags, 'reason'), '推荐理由', 2000),
      draft.draft_id,
      key,
    );
    touchDraft(db, draft.draft_id);
    return `反馈澄清问题 ${key} 的推荐选项已保存。`;
  }
  if (command === 'feedback question remove') {
    assertMode(current, 'triage');
    const key = required(flags, 'key');
    const answered = current.questions.find((item) => item.decision_key === key)?.answer;
    if (answered) throw new Error(`问题 ${key} 已回答，必须保留原 decision key 并消费回答`);
    db.prepare(`
      DELETE FROM feedback_draft_questions
      WHERE draft_id = ? AND decision_key = ?
    `).run(draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return '反馈澄清问题已删除。';
  }
  if (command === 'feedback verification reason set') {
    assertMode(current, 'verify');
    db.prepare(`
      UPDATE feedback_drafts SET verification_reason = ? WHERE draft_id = ?
    `).run(bounded(required(flags, 'text'), '验证理由'), draft.draft_id);
    touchDraft(db, draft.draft_id);
    return '反馈验证理由已保存。';
  }
  if (command === 'feedback evidence upsert') {
    assertMode(current, 'verify');
    const key = bounded(required(flags, 'key'), '证据 key', 120);
    const ordinal = nextOrdinal(db, 'feedback_draft_evidence', draft.draft_id);
    db.prepare(`
      INSERT INTO feedback_draft_evidence(draft_id, evidence_key, content, ordinal)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(draft_id, evidence_key) DO UPDATE SET content = excluded.content
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'text'), '验证证据', 2000),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `反馈验证证据 ${key} 已保存。`;
  }
  if (command === 'feedback evidence remove') {
    assertMode(current, 'verify');
    db.prepare(`
      DELETE FROM feedback_draft_evidence
      WHERE draft_id = ? AND evidence_key = ?
    `).run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '反馈验证证据已删除。';
  }
  if (command === 'feedback triage-complete') {
    return terminalSubmit(db, draft, execution, 'triage-complete');
  }
  if (command === 'feedback request-clarification') {
    return terminalSubmit(db, draft, execution, 'request-clarification');
  }
  if (command === 'feedback resolve') return terminalSubmit(db, draft, execution, 'resolve');
  if (command === 'feedback reopen') return terminalSubmit(db, draft, execution, 'reopen');
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}
