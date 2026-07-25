import { agentResultSchema } from '../domain/agent-result';
import { databaseConnection } from '../infrastructure/database';

type Db = Awaited<ReturnType<typeof databaseConnection>>;
type FlagMap = Map<string, string>;

export type ReviewDraftRow = {
  draft_id: string;
  draft_version: number;
  task_id: string;
  status: 'editing' | 'waiting_for_answers' | 'submitted' | 'abandoned';
  change_seq: number;
  status_viewed_execution_id: string | null;
  terminal_execution_id: string | null;
  terminal_action: string | null;
};

export type ReviewExecutionRow = {
  execution_id: string;
};

const SECTION_KINDS = [
  'outcome',
  'scope',
  'decisions',
  'implementation',
  'verification',
  'deviations',
  'risks',
  'feedback',
] as const;

type SectionKind = typeof SECTION_KINDS[number];

const DEFAULT_HEADINGS: Record<SectionKind, string> = {
  outcome: '原始目标与最终结果',
  scope: '实际交付范围',
  decisions: '关键决策与取舍',
  implementation: '实现与代码变化',
  verification: '验收与验证证据',
  deviations: '偏差与妥协',
  risks: '已知限制与后续建议',
  feedback: '评论与反馈处理',
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

function sectionKind(flags: FlagMap) {
  const value = required(flags, 'kind') as SectionKind;
  if (!SECTION_KINDS.includes(value)) {
    throw new Error(`--kind 必须是 ${SECTION_KINDS.join('、')}`);
  }
  return value;
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

function assertViewed(draft: ReviewDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 review status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function state(db: Db, draft: ReviewDraftRow) {
  const header = db.prepare(`
    SELECT title, summary FROM review_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as { title: string | null; summary: string | null };
  const sections = db.prepare(`
    SELECT section_kind, heading, content
    FROM review_sections WHERE draft_id = ?
  `).all(draft.draft_id) as {
    section_kind: SectionKind;
    heading: string;
    content: string;
  }[];
  const evidence = db.prepare(`
    SELECT evidence_key, section_kind, reference, claim, ordinal
    FROM review_evidence
    WHERE draft_id = ? ORDER BY ordinal, evidence_key
  `).all(draft.draft_id) as {
    evidence_key: string;
    section_kind: SectionKind;
    reference: string;
    claim: string;
    ordinal: number;
  }[];
  const runtimeInputs = db.prepare(`
    SELECT request_key, title, question, why, recommendation, ordinal
    FROM review_runtime_inputs
    WHERE draft_id = ? ORDER BY ordinal, request_key
  `).all(draft.draft_id) as {
    request_key: string;
    title: string;
    question: string;
    why: string;
    recommendation: string;
    ordinal: number;
  }[];
  const answers = db.prepare(`
    SELECT request_key, answer, status
    FROM runtime_input_requests
    WHERE task_id = ? AND story_index IS NULL AND source_agent = 'review-agent'
      AND request_key IS NOT NULL
    ORDER BY created_at, request_id
  `).all(draft.task_id) as {
    request_key: string;
    answer: string | null;
    status: string;
  }[];
  const answerMap = new Map(answers.map((row) => [row.request_key, row]));
  return {
    header,
    sections: SECTION_KINDS.map((kind) => ({
      kind,
      value: sections.find((section) => section.section_kind === kind) || null,
      evidence: evidence.filter((item) => item.section_kind === kind),
    })),
    evidence,
    runtimeInputs: runtimeInputs.map((item) => ({
      ...item,
      answer: answerMap.get(item.request_key)?.answer || null,
      answerStatus: answerMap.get(item.request_key)?.status || null,
    })),
  };
}

type ReviewState = ReturnType<typeof state>;
type TerminalAction = 'complete' | 'request-input';

function validationErrors(current: ReviewState, terminal: TerminalAction | null = null) {
  const errors: string[] = [];
  if (!current.header.summary?.trim()) errors.push('缺少结卡摘要');
  if (terminal === 'complete') {
    if (!current.header.title?.trim()) errors.push('缺少结卡报告标题');
    const missing = current.sections.filter((section) => !section.value).map((section) => section.kind);
    if (missing.length) errors.push(`缺少标准章节：${missing.join(', ')}`);
    for (const kind of ['implementation', 'verification'] as const) {
      if (!current.sections.find((section) => section.kind === kind)?.evidence.length) {
        errors.push(`${kind} 章节至少需要一条可追溯证据`);
      }
    }
    if (current.runtimeInputs.some((item) => !item.answer)) {
      errors.push('仍有未回答的运行信息请求，不能完成结卡报告');
    }
  }
  if (terminal === 'request-input'
    && !current.runtimeInputs.some((item) => !item.answer)) {
    errors.push('没有待用户补充的运行信息，不能 request-input');
  }
  return [...new Set(errors)];
}

function renderStatus(draft: ReviewDraftRow, current: ReviewState) {
  const lines = [
    `结卡报告草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    `标题：${current.header.title || '未填写'}`,
    `摘要：${current.header.summary || '未填写'}`,
    `章节：${current.sections.filter((section) => section.value).length}/${SECTION_KINDS.length}`,
    `可追溯证据：${current.evidence.length}`,
    `运行信息：${current.runtimeInputs.length}（已回答 ${current.runtimeInputs.filter((item) => item.answer).length}）`,
    '',
    '标准章节（按 kind 覆盖，不要换名堆叠）：',
  ];
  for (const section of current.sections) {
    lines.push(
      `- ${section.kind} · ${section.value?.heading || DEFAULT_HEADINGS[section.kind]}：`
      + `${section.value ? '已填写' : '缺失'} · 证据 ${section.evidence.length}`,
    );
  }
  if (current.evidence.length) {
    lines.push('', '证据索引（跨轮次必须复用 evidence key）：');
    for (const item of current.evidence) {
      lines.push(`- ${item.evidence_key} · ${item.section_kind} · ${item.reference}：${item.claim}`);
    }
  }
  if (current.runtimeInputs.length) {
    lines.push('', '运行信息（request key 跨轮次不可改名）：');
    for (const item of current.runtimeInputs) {
      lines.push(`- ${item.request_key}：${item.title} · ${item.answer ? `已回答=${item.answer}` : '待回答'}`);
    }
  }
  const errors = validationErrors(current);
  if (errors.length) {
    lines.push('', '当前校验提示：', ...errors.map((item, index) => `${index + 1}. ${item}`));
  } else {
    lines.push('', '基础草稿已建立；请补齐全部章节和关键证据后完成。');
  }
  return lines.join('\n');
}

function renderArtifact(current: ReviewState) {
  const lines = [
    `# ${current.header.title}`,
    '',
    current.header.summary || '',
  ];
  for (const section of current.sections) {
    if (!section.value) continue;
    lines.push('', `## ${section.value.heading}`, '', section.value.content);
    if (section.evidence.length) {
      lines.push('', '证据：', '');
      for (const item of section.evidence) {
        lines.push(`- \`${item.reference}\` — ${item.claim}`);
      }
    }
  }
  return lines.join('\n').trim();
}

function buildResult(current: ReviewState, action: TerminalAction) {
  if (action === 'request-input') {
    return agentResultSchema.parse({
      outcome: 'needs_input',
      summary: current.header.summary,
      runtimeInputs: current.runtimeInputs.filter((item) => !item.answer).map((item) => ({
        key: item.request_key,
        title: item.title,
        question: item.question,
        why: item.why,
        recommendation: item.recommendation,
      })),
    });
  }
  return agentResultSchema.parse({
    outcome: 'completed',
    summary: current.header.summary,
    artifact: {
      title: current.header.title,
      content: renderArtifact(current),
    },
    verdict: 'report_ready',
  });
}

function terminalSubmit(
  db: Db,
  draft: ReviewDraftRow,
  execution: ReviewExecutionRow,
  action: TerminalAction,
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft);
  const errors = validationErrors(current, action);
  if (errors.length) {
    throw new Error(`结卡报告草稿不能执行 ${action}：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
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
      SET result_json = ?, status = 'output_received', heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ?
    `).run(JSON.stringify(result), execution.execution_id);
  })();
  return action === 'complete'
    ? '结卡报告已提交。'
    : '结卡报告运行信息请求已提交，等待用户补充。';
}

export function reviewHelp(terminalActions: string[]) {
  return [
    '  review status',
    '  review title set --text <报告标题>',
    '  review summary set --text <结卡摘要>',
    `  review section upsert --kind <${SECTION_KINDS.join('|')}> --heading <章节标题> --content <Markdown 正文>`,
    `  review section remove --kind <${SECTION_KINDS.join('|')}>`,
    `  review evidence upsert --key <稳定 key> --section <${SECTION_KINDS.join('|')}> --reference <SPEC/DOC/Commit/Test/Feedback 引用> --claim <该证据支持的事实>`,
    '  review evidence remove --key <稳定 key>',
    '  review runtime-input upsert --key <稳定 key> --title <标题> --question <问题> --why <原因> --recommendation <建议>',
    '  review runtime-input remove --key <稳定 key>',
    '',
    '终止命令：',
    ...terminalActions.map((action) => `  ${action}`),
  ];
}

export function runReviewCommand(input: {
  db: Db;
  execution: ReviewExecutionRow;
  draft: ReviewDraftRow;
  command: string;
  flags: FlagMap;
}) {
  const { db, execution, draft, command, flags } = input;
  if (command === 'review status') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    return renderStatus({ ...draft, status_viewed_execution_id: execution.execution_id }, state(db, draft));
  }
  if (
    ['review complete', 'review request-input'].includes(command)
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === command.replace('review ', '')
  ) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);

  if (command === 'review title set') {
    db.prepare('UPDATE review_drafts SET title = ? WHERE draft_id = ?')
      .run(bounded(required(flags, 'text'), '报告标题', 240), draft.draft_id);
    touchDraft(db, draft.draft_id);
    return '结卡报告标题已保存。';
  }
  if (command === 'review summary set') {
    db.prepare('UPDATE review_drafts SET summary = ? WHERE draft_id = ?')
      .run(bounded(required(flags, 'text'), '结卡摘要', 10000), draft.draft_id);
    touchDraft(db, draft.draft_id);
    return '结卡摘要已保存。';
  }
  if (command === 'review section upsert') {
    const kind = sectionKind(flags);
    db.prepare(`
      INSERT INTO review_sections(draft_id, section_kind, heading, content)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(draft_id, section_kind) DO UPDATE SET
        heading = excluded.heading, content = excluded.content
    `).run(
      draft.draft_id,
      kind,
      bounded(required(flags, 'heading'), '章节标题', 240),
      bounded(required(flags, 'content'), '章节正文', 30000),
    );
    touchDraft(db, draft.draft_id);
    return `结卡报告章节 ${kind} 已保存。`;
  }
  if (command === 'review section remove') {
    const kind = sectionKind(flags);
    db.prepare('DELETE FROM review_sections WHERE draft_id = ? AND section_kind = ?')
      .run(draft.draft_id, kind);
    touchDraft(db, draft.draft_id);
    return `结卡报告章节 ${kind} 已删除。`;
  }
  if (command === 'review evidence upsert') {
    const key = bounded(required(flags, 'key'), '证据 key', 120);
    const section = required(flags, 'section') as SectionKind;
    if (!SECTION_KINDS.includes(section)) {
      throw new Error(`--section 必须是 ${SECTION_KINDS.join('、')}`);
    }
    const ordinal = nextOrdinal(db, 'review_evidence', draft.draft_id);
    db.prepare(`
      INSERT INTO review_evidence(
        draft_id, evidence_key, section_kind, reference, claim, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, evidence_key) DO UPDATE SET
        section_kind = excluded.section_kind,
        reference = excluded.reference,
        claim = excluded.claim
    `).run(
      draft.draft_id,
      key,
      section,
      bounded(required(flags, 'reference'), '证据引用', 500),
      bounded(required(flags, 'claim'), '证据事实', 2000),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `结卡证据 ${key} 已保存。`;
  }
  if (command === 'review evidence remove') {
    db.prepare('DELETE FROM review_evidence WHERE draft_id = ? AND evidence_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '结卡证据已删除。';
  }
  if (command === 'review runtime-input upsert') {
    const key = bounded(required(flags, 'key'), '运行信息 key', 120);
    const ordinal = nextOrdinal(db, 'review_runtime_inputs', draft.draft_id);
    db.prepare(`
      INSERT INTO review_runtime_inputs(
        draft_id, request_key, title, question, why, recommendation, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, request_key) DO UPDATE SET
        title = excluded.title, question = excluded.question, why = excluded.why,
        recommendation = excluded.recommendation
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'title'), '运行信息标题', 200),
      bounded(required(flags, 'question'), '运行信息问题'),
      bounded(required(flags, 'why'), '请求原因', 1000),
      bounded(required(flags, 'recommendation'), '建议', 2000),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `结卡运行信息 ${key} 已保存。`;
  }
  if (command === 'review runtime-input remove') {
    const key = required(flags, 'key');
    const answered = state(db, draft).runtimeInputs.find((item) => item.request_key === key)?.answer;
    if (answered) throw new Error(`运行信息 ${key} 已回答，必须保留原 request key 并消费回答`);
    db.prepare('DELETE FROM review_runtime_inputs WHERE draft_id = ? AND request_key = ?')
      .run(draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return '结卡运行信息已删除。';
  }
  if (command === 'review complete') return terminalSubmit(db, draft, execution, 'complete');
  if (command === 'review request-input') return terminalSubmit(db, draft, execution, 'request-input');
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}
