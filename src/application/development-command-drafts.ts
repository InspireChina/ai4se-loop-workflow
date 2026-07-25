import { agentResultSchema } from '../domain/agent-result';
import { gitChangedFilesBetween, gitHead } from '../infrastructure/git';
import { databaseConnection, paths } from '../infrastructure/database';

type Db = Awaited<ReturnType<typeof databaseConnection>>;
type FlagMap = Map<string, string>;

export type DevelopmentDraftRow = {
  draft_id: string;
  draft_version: number;
  task_id: string;
  story_index: number | null;
  status: 'editing' | 'waiting_for_answers' | 'submitted' | 'abandoned';
  change_seq: number;
  status_viewed_execution_id: string | null;
  terminal_execution_id: string | null;
  terminal_action: string | null;
};

export type DevelopmentExecutionRow = {
  execution_id: string;
  base_commit: string | null;
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

function booleanFlag(flags: FlagMap, name: string) {
  const value = required(flags, name).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${name} 必须是 true 或 false`);
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

function assertViewed(draft: DevelopmentDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 implementation status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function state(db: Db, draft: DevelopmentDraftRow) {
  const header = db.prepare(`
    SELECT summary, assessment_mode, implementation_notes, commit_sha, failure_summary
    FROM development_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    summary: string | null;
    assessment_mode: 'existing' | 'changed' | null;
    implementation_notes: string | null;
    commit_sha: string | null;
    failure_summary: string | null;
  };
  const criteria = db.prepare(`
    SELECT criterion_key, status, evidence, ordinal
    FROM development_criteria WHERE draft_id = ? ORDER BY ordinal, criterion_key
  `).all(draft.draft_id) as {
    criterion_key: string;
    status: 'covered' | 'not_covered';
    evidence: string;
    ordinal: number;
  }[];
  const changes = db.prepare(`
    SELECT path, summary, ordinal
    FROM development_changes WHERE draft_id = ? ORDER BY ordinal, path
  `).all(draft.draft_id) as { path: string; summary: string; ordinal: number }[];
  const tests = db.prepare(`
    SELECT test_key, command, passed, summary, ordinal
    FROM development_tests WHERE draft_id = ? ORDER BY ordinal, test_key
  `).all(draft.draft_id) as {
    test_key: string;
    command: string;
    passed: number;
    summary: string;
    ordinal: number;
  }[];
  const risks = db.prepare(`
    SELECT risk_key, content, ordinal
    FROM development_risks WHERE draft_id = ? ORDER BY ordinal, risk_key
  `).all(draft.draft_id) as { risk_key: string; content: string; ordinal: number }[];
  const runtimeInputs = db.prepare(`
    SELECT request_key, title, question, why, recommendation, ordinal
    FROM development_runtime_inputs WHERE draft_id = ? ORDER BY ordinal, request_key
  `).all(draft.draft_id) as {
    request_key: string;
    title: string;
    question: string;
    why: string;
    recommendation: string;
    ordinal: number;
  }[];
  const inputAnswers = db.prepare(`
    SELECT request_key, answer, status
    FROM runtime_input_requests
    WHERE task_id = ? AND story_index IS ? AND source_agent = 'dev-agent'
      AND request_key IS NOT NULL
    ORDER BY created_at, request_id
  `).all(draft.task_id, draft.story_index) as {
    request_key: string;
    answer: string | null;
    status: string;
  }[];
  const answerMap = new Map(inputAnswers.map((row) => [row.request_key, row]));
  const recovery = db.prepare(`
    SELECT recovery_id, summary, evidence, ordinal
    FROM development_recovery_resolutions
    WHERE draft_id = ? ORDER BY ordinal, recovery_id
  `).all(draft.draft_id) as {
    recovery_id: string;
    summary: string;
    evidence: string;
    ordinal: number;
  }[];
  const specRow = db.prepare(`
    SELECT spec_json
    FROM story_specs
    WHERE task_id = ? AND story_index = ? AND status = 'resolved'
    ORDER BY revision DESC LIMIT 1
  `).get(draft.task_id, draft.story_index) as { spec_json: string } | undefined;
  let expectedCriteria: { id: string; description: string; oracle: string }[] = [];
  let budgetPaths: string[] = [];
  try {
    const parsed = specRow ? JSON.parse(specRow.spec_json) as {
      acceptanceCriteria?: { id: string; description: string; oracle: string }[];
      changeBudget?: { paths?: string[] };
    } : null;
    expectedCriteria = parsed?.acceptanceCriteria || [];
    budgetPaths = parsed?.changeBudget?.paths || [];
  } catch {
    // saveStorySpec validates JSON before persistence; retain a useful validation error below.
  }
  return {
    header,
    criteria,
    changes,
    tests,
    risks,
    runtimeInputs: runtimeInputs.map((item) => ({
      ...item,
      answer: answerMap.get(item.request_key)?.answer || null,
      answerStatus: answerMap.get(item.request_key)?.status || null,
    })),
    recovery,
    expectedCriteria,
    budgetPaths,
  };
}

type DevelopmentState = ReturnType<typeof state>;

function changedCommitEvidence(
  execution: DevelopmentExecutionRow,
  current: DevelopmentState,
) {
  const head = gitHead(paths.root);
  const commit = current.header.commit_sha?.trim() || '';
  const actualFiles = execution.base_commit && head
    ? gitChangedFilesBetween(paths.root, execution.base_commit, head)
    : [];
  const errors: string[] = [];
  if (!commit) errors.push('有代码改动时必须记录 commit：implementation commit set --sha <commit>');
  if (!execution.base_commit) errors.push('当前 execution 缺少 Git 基线，不能验证开发提交');
  if (!head) errors.push('当前工作区没有可读取的 Git HEAD');
  if (commit && head && commit !== head && !head.startsWith(commit)) {
    errors.push(`记录的 commit ${commit} 不是当前 HEAD ${head}`);
  }
  if (execution.base_commit && head && execution.base_commit === head) {
    errors.push('声明有代码改动，但当前 HEAD 与 execution 基线相同');
  }
  if (execution.base_commit && head && execution.base_commit !== head && !actualFiles.length) {
    errors.push('基线到当前 HEAD 没有可识别的文件变更');
  }
  const recorded = new Set(current.changes.map((item) => item.path));
  const missing = actualFiles.filter((path) => !recorded.has(path));
  if (missing.length) errors.push(`真实提交中的文件尚未记录：${missing.join(', ')}`);
  const nonexistent = current.changes.map((item) => item.path).filter((path) => !actualFiles.includes(path));
  if (nonexistent.length) errors.push(`草稿记录了不在本次提交中的文件：${nonexistent.join(', ')}`);
  return { errors, head, actualFiles };
}

function validationErrors(
  execution: DevelopmentExecutionRow,
  current: DevelopmentState,
  terminal: 'complete' | 'request-input' | 'fail' | null = null,
) {
  const errors: string[] = [];
  if (!current.header.summary?.trim()) errors.push('缺少实现结论摘要');
  if (!current.header.assessment_mode && terminal !== 'request-input' && terminal !== 'fail') {
    errors.push('缺少走查结论：assessment mode 必须是 existing 或 changed');
  }
  if (!current.header.implementation_notes?.trim() && terminal !== 'request-input') {
    errors.push('缺少实现说明');
  }
  if (!current.expectedCriteria.length) errors.push('当前交付单元没有可读取的 resolved Slice Spec 验收标准');
  const expectedKeys = new Set(current.expectedCriteria.map((item) => item.id));
  const unknownKeys = current.criteria.map((item) => item.criterion_key).filter((key) => !expectedKeys.has(key));
  if (unknownKeys.length) errors.push(`覆盖记录引用了不存在的验收标准：${unknownKeys.join(', ')}`);
  const missingKeys = current.expectedCriteria.map((item) => item.id)
    .filter((key) => !current.criteria.some((item) => item.criterion_key === key));
  if (terminal === 'complete' && missingKeys.length) {
    errors.push(`以下验收标准尚未逐条记录：${missingKeys.join(', ')}`);
  }
  if (terminal === 'complete') {
    const uncovered = current.criteria.filter((item) => item.status !== 'covered');
    if (uncovered.length) errors.push(`以下验收标准仍未覆盖：${uncovered.map((item) => item.criterion_key).join(', ')}`);
    if (!current.tests.length) errors.push('至少需要一条真实验证记录');
    const failedTests = current.tests.filter((item) => !item.passed);
    if (failedTests.length) errors.push(`仍有失败验证：${failedTests.map((item) => item.test_key).join(', ')}`);
    if (current.runtimeInputs.some((item) => !item.answer)) {
      errors.push('仍有未回答的运行信息请求，不能完成开发');
    }
    if (current.header.assessment_mode === 'existing') {
      if (current.changes.length) errors.push('走查结论为 existing 时不能记录本轮代码变更');
      if (current.header.commit_sha) errors.push('走查结论为 existing 时不应记录 commit');
    }
    if (current.header.assessment_mode === 'changed') {
      if (!current.changes.length) errors.push('走查结论为 changed 时至少记录一个实际变更文件');
      errors.push(...changedCommitEvidence(execution, current).errors);
    }
  }
  if (terminal === 'request-input') {
    const unanswered = current.runtimeInputs.filter((item) => !item.answer);
    if (!unanswered.length) errors.push('没有待用户补充的运行信息，不能 request-input');
  }
  if (terminal === 'fail' && !current.header.failure_summary?.trim()) {
    errors.push('终止为失败前必须记录 failure summary');
  }
  return [...new Set(errors)];
}

function renderStatus(
  execution: DevelopmentExecutionRow,
  draft: DevelopmentDraftRow,
  current: DevelopmentState,
) {
  const errors = validationErrors(execution, current);
  const lines = [
    `开发实现草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    `结论摘要：${current.header.summary || '未填写'}`,
    `走查模式：${current.header.assessment_mode || '未填写'}`,
    `实现说明：${current.header.implementation_notes || '未填写'}`,
    `Commit：${current.header.commit_sha || '未记录'}`,
    `验收覆盖：${current.criteria.filter((item) => item.status === 'covered').length}/${current.expectedCriteria.length}`,
    `变更文件：${current.changes.length}`,
    `验证：${current.tests.length}（通过 ${current.tests.filter((item) => item.passed).length} / 失败 ${current.tests.filter((item) => !item.passed).length}）`,
    `风险：${current.risks.length}`,
    `运行信息：${current.runtimeInputs.length}（已回答 ${current.runtimeInputs.filter((item) => item.answer).length}）`,
    `恢复事项：${current.recovery.length}`,
  ];
  if (current.expectedCriteria.length) {
    lines.push('', '验收标准（criterion key 必须复用规格 ID）：');
    for (const criterion of current.expectedCriteria) {
      const coverage = current.criteria.find((item) => item.criterion_key === criterion.id);
      lines.push(`- ${criterion.id}：${criterion.description} · ${coverage ? `${coverage.status} · ${coverage.evidence}` : '尚未记录'}`);
    }
  }
  if (current.changes.length) {
    lines.push('', '变更文件：', ...current.changes.map((item) => `- ${item.path}：${item.summary}`));
  }
  if (current.tests.length) {
    lines.push('', '验证记录：', ...current.tests.map((item) =>
      `- ${item.test_key} · ${item.passed ? '通过' : '失败'}：${item.command} · ${item.summary}`));
  }
  if (current.runtimeInputs.length) {
    lines.push('', '运行信息（request key 跨轮次不可改名）：');
    for (const input of current.runtimeInputs) {
      lines.push(`- ${input.request_key}：${input.title} · ${input.answer ? `已回答=${input.answer}` : '待回答'}`);
    }
  }
  if (current.budgetPaths.length) {
    lines.push('', '规格允许影响的路径：', ...current.budgetPaths.map((item) => `- ${item}`));
  }
  if (errors.length) {
    lines.push('', '当前校验提示：', ...errors.map((item, index) => `${index + 1}. ${item}`));
  } else {
    lines.push('', '开发实现草稿结构完整，可根据实际结果选择终止命令。');
  }
  return lines.join('\n');
}

function renderArtifact(current: DevelopmentState) {
  const lines = [
    '# 开发实现结果',
    '',
    '## 结论',
    '',
    current.header.summary || '',
    '',
    '## 实现说明',
    '',
    current.header.implementation_notes || '',
    '',
    '## 验收覆盖',
    '',
    ...current.expectedCriteria.map((criterion) => {
      const coverage = current.criteria.find((item) => item.criterion_key === criterion.id);
      return `- **${criterion.id}** ${criterion.description}：${coverage?.status === 'covered' ? '已覆盖' : '未覆盖'}${coverage ? ` — ${coverage.evidence}` : ''}`;
    }),
    '',
    '## 代码变更',
    '',
    ...(current.changes.length
      ? current.changes.map((item) => `- \`${item.path}\`：${item.summary}`)
      : ['- 走查确认现有实现已满足规格，本轮未修改代码。']),
    ...(current.header.commit_sha ? ['', `Commit：\`${current.header.commit_sha}\``] : []),
    '',
    '## 验证记录',
    '',
    ...(current.tests.length
      ? current.tests.map((item) => `- ${item.passed ? '通过' : '失败'} \`${item.command}\`：${item.summary}`)
      : ['- 尚无验证记录']),
    '',
    '## 已知风险',
    '',
    ...(current.risks.length ? current.risks.map((item) => `- ${item.content}`) : ['- 未发现已知残余风险']),
  ];
  if (current.recovery.length) {
    lines.push('', '## 恢复事项处理', '');
    for (const item of current.recovery) lines.push(`- **${item.recovery_id}**：${item.summary}（证据：${item.evidence}）`);
  }
  if (current.header.failure_summary) {
    lines.push('', '## 失败说明', '', current.header.failure_summary);
  }
  return lines.join('\n');
}

function buildResult(
  execution: DevelopmentExecutionRow,
  current: DevelopmentState,
  action: 'complete' | 'request-input' | 'fail',
) {
  const commitEvidence = current.header.assessment_mode === 'changed'
    ? changedCommitEvidence(execution, current)
    : { actualFiles: [] as string[] };
  return agentResultSchema.parse({
    outcome: action === 'complete' ? 'completed' : action === 'request-input' ? 'needs_input' : 'failed',
    summary: action === 'fail' ? current.header.failure_summary! : current.header.summary!,
    artifact: {
      title: '开发实现结果',
      content: renderArtifact(current),
    },
    changedFiles: action === 'complete' && current.header.assessment_mode === 'changed'
      ? commitEvidence.actualFiles
      : [],
    runtimeInputs: action === 'request-input'
      ? current.runtimeInputs.filter((item) => !item.answer).map((item) => ({
        key: item.request_key,
        title: item.title,
        question: item.question,
        why: item.why,
        recommendation: item.recommendation,
      }))
      : [],
    recoveryResolutions: current.recovery.map((item) => ({
      recoveryId: item.recovery_id,
      summary: item.summary,
      evidence: [item.evidence],
    })),
    tests: current.tests.map((item) => ({
      command: item.command,
      passed: Boolean(item.passed),
      summary: item.summary,
    })),
  });
}

function terminalSubmit(
  db: Db,
  draft: DevelopmentDraftRow,
  execution: DevelopmentExecutionRow,
  action: 'complete' | 'request-input' | 'fail',
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft);
  const errors = validationErrors(execution, current, action);
  if (errors.length) {
    throw new Error(`开发草稿不能执行 ${action}：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  const result = buildResult(execution, current, action);
  const status = action === 'request-input' ? 'waiting_for_answers' : 'submitted';
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
    ? '开发实现结果已提交。'
    : action === 'request-input'
      ? '运行信息请求已提交，等待用户补充。'
      : '开发失败结果已提交。';
}

function upsertSimple(
  db: Db,
  table: 'development_changes' | 'development_risks',
  draftId: string,
  keyColumn: 'path' | 'risk_key',
  key: string,
  valueColumn: 'summary' | 'content',
  value: string,
) {
  const ordinal = nextOrdinal(db, table, draftId);
  db.prepare(`
    INSERT INTO ${table}(draft_id, ${keyColumn}, ${valueColumn}, ordinal)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(draft_id, ${keyColumn}) DO UPDATE SET ${valueColumn} = excluded.${valueColumn}
  `).run(draftId, key, value, ordinal);
}

export function developmentHelp(terminalActions: string[]) {
  return [
    '  implementation status',
    '  implementation summary set --text <结论摘要>',
    '  implementation assessment set --mode <existing|changed>',
    '  implementation notes set --text <实现说明>',
    '  implementation criterion upsert --key <规格 criterion id> --status <covered|not-covered> --evidence <证据>',
    '  implementation criterion remove --key <规格 criterion id>',
    '  implementation change upsert --path <仓库相对路径> --summary <改动说明>',
    '  implementation change remove --path <仓库相对路径>',
    '  implementation test upsert --key <稳定 key> --command <真实命令> --passed <true|false> --summary <结果>',
    '  implementation test remove --key <稳定 key>',
    '  implementation risk upsert --key <稳定 key> --content <残余风险>',
    '  implementation risk remove --key <稳定 key>',
    '  implementation runtime-input upsert --key <稳定 key> --title <标题> --question <问题> --why <原因> --recommendation <建议>',
    '  implementation runtime-input remove --key <稳定 key>',
    '  implementation recovery upsert --id <RECOVERY id> --summary <处理方式> --evidence <证据>',
    '  implementation recovery remove --id <RECOVERY id>',
    '  implementation commit set --sha <当前 HEAD>',
    '  implementation failure set --summary <无法完成的原因>',
    '  implementation validate',
    ...terminalActions.map((action) => `  ${action}`),
  ];
}

export function runDevelopmentCommand(input: {
  db: Db;
  execution: DevelopmentExecutionRow;
  draft: DevelopmentDraftRow;
  command: string;
  flags: FlagMap;
}) {
  const { db, execution, draft, command, flags } = input;
  if (command === 'implementation status') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    return renderStatus(execution, { ...draft, status_viewed_execution_id: execution.execution_id }, state(db, draft));
  }
  if (
    ['implementation complete', 'implementation request-input', 'implementation fail'].includes(command)
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === command.replace('implementation ', '')
  ) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);

  if (command === 'implementation summary set' || command === 'implementation notes set') {
    const column = command.includes('summary') ? 'summary' : 'implementation_notes';
    const value = bounded(required(flags, 'text'), column === 'summary' ? '结论摘要' : '实现说明', 10000);
    db.prepare(`UPDATE development_drafts SET ${column} = ? WHERE draft_id = ?`).run(value, draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `${column === 'summary' ? '结论摘要' : '实现说明'}已保存。`;
  }
  if (command === 'implementation assessment set') {
    const mode = required(flags, 'mode');
    if (!['existing', 'changed'].includes(mode)) throw new Error('--mode 必须是 existing 或 changed');
    db.prepare('UPDATE development_drafts SET assessment_mode = ? WHERE draft_id = ?').run(mode, draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `走查模式已设置为 ${mode}。`;
  }
  if (command === 'implementation criterion upsert') {
    const key = bounded(required(flags, 'key'), '验收标准 key', 120);
    const status = required(flags, 'status').replace('-', '_');
    if (!['covered', 'not_covered'].includes(status)) throw new Error('--status 必须是 covered 或 not-covered');
    const evidence = bounded(required(flags, 'evidence'), '覆盖证据');
    const ordinal = nextOrdinal(db, 'development_criteria', draft.draft_id);
    db.prepare(`
      INSERT INTO development_criteria(draft_id, criterion_key, status, evidence, ordinal)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, criterion_key) DO UPDATE SET
        status = excluded.status, evidence = excluded.evidence
    `).run(draft.draft_id, key, status, evidence, ordinal);
    touchDraft(db, draft.draft_id);
    return `验收覆盖 ${key} 已保存。`;
  }
  if (command === 'implementation criterion remove') {
    db.prepare('DELETE FROM development_criteria WHERE draft_id = ? AND criterion_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '验收覆盖已删除。';
  }
  if (command === 'implementation change upsert') {
    const path = bounded(required(flags, 'path'), '变更路径', 1000);
    if (path.startsWith('/') || path.includes('..')) throw new Error('变更路径必须是安全的仓库相对路径');
    upsertSimple(
      db, 'development_changes', draft.draft_id, 'path', path,
      'summary', bounded(required(flags, 'summary'), '变更说明'),
    );
    touchDraft(db, draft.draft_id);
    return `变更文件 ${path} 已保存。`;
  }
  if (command === 'implementation change remove') {
    db.prepare('DELETE FROM development_changes WHERE draft_id = ? AND path = ?')
      .run(draft.draft_id, required(flags, 'path'));
    touchDraft(db, draft.draft_id);
    return '变更文件已删除。';
  }
  if (command === 'implementation test upsert') {
    const key = bounded(required(flags, 'key'), '验证 key', 120);
    const ordinal = nextOrdinal(db, 'development_tests', draft.draft_id);
    db.prepare(`
      INSERT INTO development_tests(draft_id, test_key, command, passed, summary, ordinal)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, test_key) DO UPDATE SET
        command = excluded.command, passed = excluded.passed, summary = excluded.summary
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'command'), '验证命令', 2000),
      booleanFlag(flags, 'passed') ? 1 : 0,
      bounded(required(flags, 'summary'), '验证摘要'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `验证记录 ${key} 已保存。`;
  }
  if (command === 'implementation test remove') {
    db.prepare('DELETE FROM development_tests WHERE draft_id = ? AND test_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '验证记录已删除。';
  }
  if (command === 'implementation risk upsert') {
    const key = bounded(required(flags, 'key'), '风险 key', 120);
    upsertSimple(
      db, 'development_risks', draft.draft_id, 'risk_key', key,
      'content', bounded(required(flags, 'content'), '风险内容'),
    );
    touchDraft(db, draft.draft_id);
    return `风险 ${key} 已保存。`;
  }
  if (command === 'implementation risk remove') {
    db.prepare('DELETE FROM development_risks WHERE draft_id = ? AND risk_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '风险已删除。';
  }
  if (command === 'implementation runtime-input upsert') {
    const key = bounded(required(flags, 'key'), '运行信息 key', 120);
    const ordinal = nextOrdinal(db, 'development_runtime_inputs', draft.draft_id);
    db.prepare(`
      INSERT INTO development_runtime_inputs(
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
    return `运行信息请求 ${key} 已保存。`;
  }
  if (command === 'implementation runtime-input remove') {
    const key = required(flags, 'key');
    const answered = state(db, draft).runtimeInputs.find((item) => item.request_key === key)?.answer;
    if (answered) throw new Error(`运行信息 ${key} 已回答，必须保留原 request key 并消费回答`);
    db.prepare('DELETE FROM development_runtime_inputs WHERE draft_id = ? AND request_key = ?')
      .run(draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return '运行信息请求已删除。';
  }
  if (command === 'implementation recovery upsert') {
    const id = bounded(required(flags, 'id'), '恢复事项 id', 200);
    const ordinal = nextOrdinal(db, 'development_recovery_resolutions', draft.draft_id);
    db.prepare(`
      INSERT INTO development_recovery_resolutions(draft_id, recovery_id, summary, evidence, ordinal)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, recovery_id) DO UPDATE SET
        summary = excluded.summary, evidence = excluded.evidence
    `).run(
      draft.draft_id,
      id,
      bounded(required(flags, 'summary'), '恢复处理摘要'),
      bounded(required(flags, 'evidence'), '恢复证据'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `恢复事项 ${id} 已保存。`;
  }
  if (command === 'implementation recovery remove') {
    db.prepare('DELETE FROM development_recovery_resolutions WHERE draft_id = ? AND recovery_id = ?')
      .run(draft.draft_id, required(flags, 'id'));
    touchDraft(db, draft.draft_id);
    return '恢复事项处理已删除。';
  }
  if (command === 'implementation commit set') {
    const sha = bounded(required(flags, 'sha'), 'commit SHA', 100);
    if (!/^[a-f0-9]{7,64}$/i.test(sha)) throw new Error('commit SHA 格式无效');
    db.prepare('UPDATE development_drafts SET commit_sha = ? WHERE draft_id = ?').run(sha, draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `Commit ${sha} 已记录。`;
  }
  if (command === 'implementation failure set') {
    const summary = bounded(required(flags, 'summary'), '失败说明');
    db.prepare('UPDATE development_drafts SET failure_summary = ? WHERE draft_id = ?')
      .run(summary, draft.draft_id);
    touchDraft(db, draft.draft_id);
    return '失败说明已保存。';
  }
  if (command === 'implementation validate') {
    const errors = validationErrors(execution, state(db, draft), 'complete');
    if (errors.length) {
      throw new Error(`开发实现草稿校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }
    return '开发实现草稿结构校验通过。';
  }
  if (command === 'implementation complete') return terminalSubmit(db, draft, execution, 'complete');
  if (command === 'implementation request-input') return terminalSubmit(db, draft, execution, 'request-input');
  if (command === 'implementation fail') return terminalSubmit(db, draft, execution, 'fail');
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}
