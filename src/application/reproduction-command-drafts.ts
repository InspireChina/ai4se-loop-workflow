import { agentResultSchema } from '../domain/agent-result';
import { databaseConnection } from '../infrastructure/database';

type Db = Awaited<ReturnType<typeof databaseConnection>>;
type FlagMap = Map<string, string>;

export type ReproductionDraftRow = {
  draft_id: string;
  draft_version: number;
  task_id: string;
  status: 'editing' | 'waiting_for_answers' | 'submitted' | 'abandoned';
  change_seq: number;
  status_viewed_execution_id: string | null;
  terminal_execution_id: string | null;
  terminal_action: string | null;
};

export type ReproductionExecutionRow = {
  execution_id: string;
};

type ReproductionHeader = {
  expected_behavior: string | null;
  actual_behavior: string | null;
  environment: string | null;
  stability: string | null;
  impact_scope: string | null;
};

type ReproductionQuestion = {
  decision_key: string;
  title: string;
  question: string;
  impact: string;
  recommendation_option_id: string | null;
  recommendation_reason: string | null;
  options: {
    option_id: string;
    label: string;
    consequence: string;
  }[];
  answer: string | null;
};

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

function nextOrdinal(db: Db, table: string, draftId: string) {
  return (db.prepare(`
    SELECT COALESCE(MAX(ordinal), 0) + 1 AS value
    FROM ${table} WHERE draft_id = ?
  `).get(draftId) as { value: number }).value;
}

function touchDraft(db: Db, draftId: string) {
  db.prepare(`
    UPDATE agent_work_drafts
    SET change_seq = change_seq + 1, updated_at = CURRENT_TIMESTAMP
    WHERE draft_id = ?
  `).run(draftId);
}

function assertViewed(draft: ReproductionDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 reproduction status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function state(db: Db, draft: ReproductionDraftRow) {
  const header = db.prepare(`
    SELECT expected_behavior, actual_behavior, environment, stability, impact_scope
    FROM reproduction_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as ReproductionHeader;
  const steps = db.prepare(`
    SELECT step_key, action, expected, actual, ordinal
    FROM reproduction_steps WHERE draft_id = ? ORDER BY ordinal, step_key
  `).all(draft.draft_id) as {
    step_key: string;
    action: string;
    expected: string;
    actual: string;
    ordinal: number;
  }[];
  const evidence = db.prepare(`
    SELECT evidence_key, kind, content, source, ordinal
    FROM reproduction_evidence WHERE draft_id = ? ORDER BY ordinal, evidence_key
  `).all(draft.draft_id) as {
    evidence_key: string;
    kind: 'log' | 'screenshot' | 'command' | 'observation';
    content: string;
    source: string;
    ordinal: number;
  }[];
  const hypotheses = db.prepare(`
    SELECT hypothesis_key, statement, status, evidence, ordinal
    FROM reproduction_hypotheses WHERE draft_id = ? ORDER BY ordinal, hypothesis_key
  `).all(draft.draft_id) as {
    hypothesis_key: string;
    statement: string;
    status: 'suspected' | 'excluded';
    evidence: string;
    ordinal: number;
  }[];
  const questionRows = db.prepare(`
    SELECT decision_key, title, question, impact,
           recommendation_option_id, recommendation_reason
    FROM reproduction_questions WHERE draft_id = ? ORDER BY ordinal, decision_key
  `).all(draft.draft_id) as Omit<ReproductionQuestion, 'options' | 'answer'>[];
  const options = db.prepare(`
    SELECT decision_key, option_id, label, consequence
    FROM reproduction_question_options
    WHERE draft_id = ? ORDER BY ordinal, option_id
  `).all(draft.draft_id) as {
    decision_key: string;
    option_id: string;
    label: string;
    consequence: string;
  }[];
  const answers = db.prepare(`
    SELECT decision_key, answer
    FROM questions
    WHERE task_id = ? AND source_agent = 'repro-agent'
      AND decision_key IS NOT NULL AND answer IS NOT NULL
    ORDER BY created_at, question_id
  `).all(draft.task_id) as { decision_key: string; answer: string }[];
  const answerMap = new Map(answers.map((row) => [row.decision_key, row.answer]));
  const questions: ReproductionQuestion[] = questionRows.map((question) => ({
    ...question,
    options: options.filter((option) => option.decision_key === question.decision_key),
    answer: answerMap.get(question.decision_key) || null,
  }));
  return { header, steps, evidence, hypotheses, questions };
}

type ReproductionState = ReturnType<typeof state>;

function validationErrors(
  current: ReproductionState,
  terminal: 'complete' | 'request-alignment' | null = null,
) {
  const errors: string[] = [];
  if (!current.header.expected_behavior?.trim()) errors.push('缺少有证据的预期行为');
  if (!current.header.actual_behavior?.trim()) errors.push('缺少实际行为');
  if (!current.header.environment?.trim()) errors.push('缺少复现环境与前置条件');
  if (!current.header.stability?.trim()) errors.push('缺少稳定性或对照实验结论');
  if (!current.header.impact_scope?.trim()) errors.push('缺少最小影响范围');
  if (!current.steps.length) errors.push('至少需要一条可重复的复现步骤');
  if (!current.evidence.length) errors.push('至少需要一条可定位的复现证据');
  if (!current.hypotheses.length) errors.push('至少需要一条根因假设或已排除方向');
  for (const question of current.questions) {
    if (question.answer) continue;
    if (question.options.length < 2) errors.push(`问题 ${question.decision_key} 至少需要两个互斥选项`);
    if (!question.recommendation_option_id) errors.push(`问题 ${question.decision_key} 缺少推荐选项`);
    else if (!question.options.some((option) => option.option_id === question.recommendation_option_id)) {
      errors.push(`问题 ${question.decision_key} 的推荐选项不存在`);
    }
    if (!question.recommendation_reason?.trim()) errors.push(`问题 ${question.decision_key} 缺少推荐理由`);
  }
  const unanswered = current.questions.filter((question) => !question.answer);
  if (terminal === 'complete' && unanswered.length) {
    errors.push(`仍有 ${unanswered.length} 个未回答问题，不能确认复现成功`);
  }
  if (terminal === 'request-alignment' && !unanswered.length) {
    errors.push('没有待用户回答的问题，不能请求人工对齐');
  }
  return errors;
}

function renderStatus(draft: ReproductionDraftRow, current: ReproductionState) {
  const errors = validationErrors(current);
  const lines = [
    `问题复现草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    `预期行为：${current.header.expected_behavior || '未填写'}`,
    `实际行为：${current.header.actual_behavior || '未填写'}`,
    `环境与前置：${current.header.environment || '未填写'}`,
    `稳定性与对照：${current.header.stability || '未填写'}`,
    `最小影响范围：${current.header.impact_scope || '未填写'}`,
    '',
    `复现步骤：${current.steps.length}`,
    `证据：${current.evidence.length}`,
    `根因假设/排除项：${current.hypotheses.length}`,
    `人工对齐问题：${current.questions.length}（已回答 ${current.questions.filter((item) => item.answer).length}）`,
  ];
  if (current.steps.length) {
    lines.push('', '步骤索引（编辑时复用 key）：');
    for (const [index, step] of current.steps.entries()) {
      lines.push(`${index + 1}. ${step.step_key}：${step.action}；期望=${step.expected}；实际=${step.actual}`);
    }
  }
  if (current.evidence.length) {
    lines.push('', '证据索引（编辑时复用 key）：');
    for (const item of current.evidence) {
      lines.push(`- ${item.evidence_key} · ${item.kind}：${item.content}（来源：${item.source}）`);
    }
  }
  if (current.hypotheses.length) {
    lines.push('', '假设索引（编辑时复用 key）：');
    for (const item of current.hypotheses) {
      lines.push(`- ${item.hypothesis_key} · ${item.status}：${item.statement}（证据：${item.evidence}）`);
    }
  }
  if (current.questions.length) {
    lines.push('', '问题索引（decision key 跨轮次不可改名）：');
    for (const question of current.questions) {
      lines.push(`- ${question.decision_key}：${question.title} · ${question.answer ? `已回答：${question.answer}` : '待回答'}`);
    }
  }
  if (errors.length) {
    lines.push('', '当前校验提示：', ...errors.map((item, index) => `${index + 1}. ${item}`));
  } else {
    lines.push('', '问题复现草稿结构完整。请根据事实选择 complete 或 request-alignment。');
  }
  return lines.join('\n');
}

function renderArtifact(current: ReproductionState) {
  const lines = [
    '# 问题复现记录',
    '',
    '## 预期行为',
    '',
    current.header.expected_behavior || '',
    '',
    '## 实际行为',
    '',
    current.header.actual_behavior || '',
    '',
    '## 环境与前置条件',
    '',
    current.header.environment || '',
    '',
    '## 最小复现步骤',
    '',
    ...current.steps.map((step, index) =>
      `${index + 1}. ${step.action}\n   - 期望：${step.expected}\n   - 实际：${step.actual}`),
    '',
    '## 证据',
    '',
    ...current.evidence.map((item) =>
      `- **${item.kind} · ${item.evidence_key}**：${item.content}（来源：${item.source}）`),
    '',
    '## 稳定性与对照实验',
    '',
    current.header.stability || '',
    '',
    '## 最小影响范围',
    '',
    current.header.impact_scope || '',
    '',
    '## 根因假设与排除项',
    '',
    ...current.hypotheses.map((item) =>
      `- **${item.status === 'excluded' ? '已排除' : '待验证'} · ${item.hypothesis_key}**：${item.statement}（证据：${item.evidence}）`),
  ];
  const unanswered = current.questions.filter((question) => !question.answer);
  if (unanswered.length) {
    lines.push('', '## 待人工对齐', '');
    for (const question of unanswered) lines.push(`- **${question.title}**：${question.question}`);
  }
  const answered = current.questions.filter((question) => question.answer);
  if (answered.length) {
    lines.push('', '## 已确认补充信息', '');
    for (const question of answered) lines.push(`- **${question.title}**：${question.answer}`);
  }
  return lines.join('\n');
}

function buildResult(current: ReproductionState, action: 'complete' | 'request-alignment') {
  const complete = action === 'complete';
  const questions = current.questions.filter((question) => !question.answer).map((question) => {
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
  return agentResultSchema.parse({
    outcome: complete ? 'completed' : 'needs_input',
    summary: complete
      ? '问题已稳定复现并形成可供方案分析使用的证据'
      : `当前条件未能稳定复现，仍需用户对齐 ${questions.length} 项信息`,
    artifact: {
      title: complete ? '问题复现证据' : '问题复现记录',
      content: renderArtifact(current),
    },
    reproVerdict: complete ? 'reproduced' : 'not_reproduced',
    ...(complete ? { route: 'plan' } : {}),
    questions,
  });
}

function submit(
  db: Db,
  draft: ReproductionDraftRow,
  execution: ReproductionExecutionRow,
  action: 'complete' | 'request-alignment',
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft);
  const errors = validationErrors(current, action);
  if (errors.length) {
    throw new Error(`问题复现草稿不能执行 ${action}：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  const result = buildResult(current, action);
  const status = action === 'complete' ? 'submitted' : 'waiting_for_answers';
  db.transaction(() => {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status = ?, terminal_action = ?, terminal_execution_id = ?,
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(status, action, execution.execution_id, draft.draft_id);
    db.prepare(`
      UPDATE execution_attempts
      SET status = 'output_received', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'running'
    `).run(JSON.stringify(result), execution.execution_id);
  })();
  return action === 'complete'
    ? '问题复现证据已提交成功。普通最终回复不再用于推进流程，可以结束本轮。'
    : '人工对齐请求已提交成功。普通最终回复不再用于推进流程，可以结束本轮。';
}

export function reproductionHelp(terminalActions: string[]) {
  return [
    '  reproduction expected set --text <有证据的预期行为>',
    '  reproduction actual set --text <实际行为>',
    '  reproduction environment set --text <环境与前置条件>',
    '  reproduction stability set --text <稳定性与对照实验>',
    '  reproduction impact set --text <最小影响范围>',
    '  reproduction step upsert --key <key> --action <动作> --expected <期望> --actual <实际>',
    '  reproduction step remove --key <key>',
    '  reproduction evidence upsert --key <key> --kind <log|screenshot|command|observation> --content <证据> --source <来源>',
    '  reproduction evidence remove --key <key>',
    '  reproduction hypothesis upsert --key <key> --status <suspected|excluded> --statement <假设> --evidence <依据>',
    '  reproduction hypothesis remove --key <key>',
    '  reproduction question add --key <key> --title <标题> --question <问题> --impact <影响>',
    '  reproduction question option-add --key <问题key> --id <选项id> --label <名称> --consequence <后果>',
    '  reproduction question recommend --key <问题key> --option <选项id> --reason <理由>',
    '  reproduction question remove --key <key>',
    '  reproduction validate',
    '',
    '终止命令：',
    ...terminalActions.map((action) => `  ${action}`),
  ];
}

export function runReproductionCommand(input: {
  db: Db;
  execution: ReproductionExecutionRow;
  draft: ReproductionDraftRow;
  command: string;
  flags: FlagMap;
}) {
  const { db, execution, command, flags } = input;
  let { draft } = input;
  if (command === 'reproduction status') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    draft = { ...draft, status_viewed_execution_id: execution.execution_id };
    return renderStatus(draft, state(db, draft));
  }
  const action = command === 'reproduction complete'
    ? 'complete'
    : command === 'reproduction request-alignment'
      ? 'request-alignment'
      : null;
  if (
    action
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === action
  ) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);

  const headerCommands: Record<string, { column: string; label: string }> = {
    'reproduction expected set': { column: 'expected_behavior', label: '预期行为' },
    'reproduction actual set': { column: 'actual_behavior', label: '实际行为' },
    'reproduction environment set': { column: 'environment', label: '环境与前置条件' },
    'reproduction stability set': { column: 'stability', label: '稳定性与对照实验' },
    'reproduction impact set': { column: 'impact_scope', label: '最小影响范围' },
  };
  const header = headerCommands[command];
  if (header) {
    db.prepare(`UPDATE reproduction_drafts SET ${header.column} = ? WHERE draft_id = ?`)
      .run(bounded(required(flags, 'text'), header.label), draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `${header.label}已保存。`;
  }
  if (command === 'reproduction step upsert') {
    const key = bounded(required(flags, 'key'), '步骤 key', 120);
    const ordinal = nextOrdinal(db, 'reproduction_steps', draft.draft_id);
    db.prepare(`
      INSERT INTO reproduction_steps(draft_id, step_key, action, expected, actual, ordinal)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, step_key) DO UPDATE SET
        action = excluded.action, expected = excluded.expected, actual = excluded.actual
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'action'), '复现动作'),
      bounded(required(flags, 'expected'), '步骤期望'),
      bounded(required(flags, 'actual'), '步骤实际'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `复现步骤 ${key} 已保存。`;
  }
  if (command === 'reproduction step remove') {
    db.prepare('DELETE FROM reproduction_steps WHERE draft_id = ? AND step_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '复现步骤已删除。';
  }
  if (command === 'reproduction evidence upsert') {
    const kind = required(flags, 'kind');
    if (!['log', 'screenshot', 'command', 'observation'].includes(kind)) {
      throw new Error('证据 kind 必须是 log、screenshot、command 或 observation');
    }
    const key = bounded(required(flags, 'key'), '证据 key', 120);
    const ordinal = nextOrdinal(db, 'reproduction_evidence', draft.draft_id);
    db.prepare(`
      INSERT INTO reproduction_evidence(
        draft_id, evidence_key, kind, content, source, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, evidence_key) DO UPDATE SET
        kind = excluded.kind, content = excluded.content, source = excluded.source
    `).run(
      draft.draft_id,
      key,
      kind,
      bounded(required(flags, 'content'), '证据内容'),
      bounded(required(flags, 'source'), '证据来源', 1000),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `复现证据 ${key} 已保存。`;
  }
  if (command === 'reproduction evidence remove') {
    db.prepare('DELETE FROM reproduction_evidence WHERE draft_id = ? AND evidence_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '复现证据已删除。';
  }
  if (command === 'reproduction hypothesis upsert') {
    const status = required(flags, 'status');
    if (!['suspected', 'excluded'].includes(status)) {
      throw new Error('假设 status 必须是 suspected 或 excluded');
    }
    const key = bounded(required(flags, 'key'), '假设 key', 120);
    const ordinal = nextOrdinal(db, 'reproduction_hypotheses', draft.draft_id);
    db.prepare(`
      INSERT INTO reproduction_hypotheses(
        draft_id, hypothesis_key, statement, status, evidence, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, hypothesis_key) DO UPDATE SET
        statement = excluded.statement, status = excluded.status, evidence = excluded.evidence
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'statement'), '根因假设'),
      status,
      bounded(required(flags, 'evidence'), '假设依据'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `根因假设 ${key} 已保存。`;
  }
  if (command === 'reproduction hypothesis remove') {
    db.prepare('DELETE FROM reproduction_hypotheses WHERE draft_id = ? AND hypothesis_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '根因假设已删除。';
  }
  if (command === 'reproduction question add') {
    const key = bounded(required(flags, 'key'), '问题 key', 120);
    const ordinal = nextOrdinal(db, 'reproduction_questions', draft.draft_id);
    db.prepare(`
      INSERT INTO reproduction_questions(
        draft_id, decision_key, title, question, impact, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, decision_key) DO UPDATE SET
        title = excluded.title, question = excluded.question, impact = excluded.impact
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'title'), '问题标题', 500),
      bounded(required(flags, 'question'), '问题内容'),
      bounded(required(flags, 'impact'), '问题影响'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `人工对齐问题 ${key} 已保存。`;
  }
  if (command === 'reproduction question option-add') {
    const key = bounded(required(flags, 'key'), '问题 key', 120);
    const exists = db.prepare(`
      SELECT 1 FROM reproduction_questions WHERE draft_id = ? AND decision_key = ?
    `).get(draft.draft_id, key);
    if (!exists) throw new Error(`问题 ${key} 不存在，请先使用 question add`);
    const ordinal = nextOrdinal(db, 'reproduction_question_options', draft.draft_id);
    db.prepare(`
      INSERT INTO reproduction_question_options(
        draft_id, decision_key, option_id, label, consequence, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, decision_key, option_id) DO UPDATE SET
        label = excluded.label, consequence = excluded.consequence
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'id'), '选项 id', 120),
      bounded(required(flags, 'label'), '选项名称', 500),
      bounded(required(flags, 'consequence'), '选项后果'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `问题 ${key} 的选项已保存。`;
  }
  if (command === 'reproduction question recommend') {
    const key = bounded(required(flags, 'key'), '问题 key', 120);
    const option = bounded(required(flags, 'option'), '推荐选项', 120);
    const exists = db.prepare(`
      SELECT 1 FROM reproduction_question_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).get(draft.draft_id, key, option);
    if (!exists) throw new Error(`问题 ${key} 不存在选项 ${option}`);
    db.prepare(`
      UPDATE reproduction_questions
      SET recommendation_option_id = ?, recommendation_reason = ?
      WHERE draft_id = ? AND decision_key = ?
    `).run(option, bounded(required(flags, 'reason'), '推荐理由'), draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return `问题 ${key} 的推荐答案已保存。`;
  }
  if (command === 'reproduction question remove') {
    db.prepare('DELETE FROM reproduction_questions WHERE draft_id = ? AND decision_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '人工对齐问题已删除。';
  }
  if (command === 'reproduction validate') {
    const errors = validationErrors(state(db, draft));
    if (errors.length) throw new Error(`问题复现草稿校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    return '问题复现草稿结构校验通过。';
  }
  if (action) return submit(db, draft, execution, action);
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}

export const reproductionCommandDraftInternals = {
  validationErrors,
  renderArtifact,
  buildResult,
};
