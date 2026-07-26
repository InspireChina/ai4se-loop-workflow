import { agentResultSchema, deliverySpecSchema } from '../domain/agent-result';
import { databaseConnection } from '../infrastructure/database';

type Db = Awaited<ReturnType<typeof databaseConnection>>;
type FlagMap = Map<string, string>;

export type VerificationDraftRow = {
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

export type VerificationExecutionRow = {
  execution_id: string;
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

function optionalInteger(flags: FlagMap, name: string) {
  const value = flags.get(name)?.trim();
  if (!value) return null;
  if (!/^-?\d+$/.test(value)) throw new Error(`--${name} 必须是整数`);
  return Number(value);
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

function assertViewed(draft: VerificationDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 verification status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function state(db: Db, draft: VerificationDraftRow) {
  const header = db.prepare(`
    SELECT summary, failure_kind, expected_behavior, actual_behavior
    FROM verification_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    summary: string | null;
    failure_kind: 'implementation' | 'specification' | 'environment' | 'inconclusive' | null;
    expected_behavior: string | null;
    actual_behavior: string | null;
  };
  const criteria = db.prepare(`
    SELECT criterion_key, status, method, evidence, ordinal
    FROM verification_criteria WHERE draft_id = ? ORDER BY ordinal, criterion_key
  `).all(draft.draft_id) as {
    criterion_key: string;
    status: 'passed' | 'failed' | 'not_tested';
    method: 'command' | 'browser' | 'inspection';
    evidence: string;
    ordinal: number;
  }[];
  const checks = db.prepare(`
    SELECT check_key, kind, instruction, command, passed, exit_code, summary, ordinal
    FROM verification_checks WHERE draft_id = ? ORDER BY ordinal, check_key
  `).all(draft.draft_id) as {
    check_key: string;
    kind: 'command' | 'browser' | 'inspection';
    instruction: string;
    command: string | null;
    passed: number;
    exit_code: number | null;
    summary: string;
    ordinal: number;
  }[];
  const risks = db.prepare(`
    SELECT risk_key, content, ordinal
    FROM verification_risks WHERE draft_id = ? ORDER BY ordinal, risk_key
  `).all(draft.draft_id) as { risk_key: string; content: string; ordinal: number }[];
  const runtimeInputs = db.prepare(`
    SELECT request_key, title, question, why, recommendation, ordinal
    FROM verification_runtime_inputs WHERE draft_id = ? ORDER BY ordinal, request_key
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
    WHERE task_id = ? AND story_index IS ? AND source_agent = 'test-agent'
      AND request_key IS NOT NULL
    ORDER BY created_at, request_id
  `).all(draft.task_id, draft.story_index) as {
    request_key: string;
    answer: string | null;
    status: string;
  }[];
  const answerMap = new Map(inputAnswers.map((row) => [row.request_key, row]));
  const recoveryChecks = db.prepare(`
    SELECT recovery_id, status, evidence, ordinal
    FROM verification_recovery_checks
    WHERE draft_id = ? ORDER BY ordinal, recovery_id
  `).all(draft.draft_id) as {
    recovery_id: string;
    status: 'verified' | 'still_failing';
    evidence: string;
    ordinal: number;
  }[];
  const activeRecoveries = db.prepare(`
    SELECT recovery_id, summary, target_stage, status
    FROM recovery_items
    WHERE task_id = ? AND story_index IS ?
      AND status IN ('pending', 'claimed', 'reopened')
    ORDER BY created_at, recovery_id
  `).all(draft.task_id, draft.story_index) as {
    recovery_id: string;
    summary: string;
    target_stage: 'analysis' | 'dev';
    status: string;
  }[];
  const specRow = db.prepare(`
    SELECT spec_json
    FROM story_specs
    WHERE task_id = ? AND story_index = ? AND status = 'resolved'
    ORDER BY revision DESC LIMIT 1
  `).get(draft.task_id, draft.story_index) as { spec_json: string } | undefined;
  let expectedCriteria: { id: string; description: string; oracle: string }[] = [];
  let verificationFocus: { key: string; expected: string; oracle: string }[] = [];
  try {
    const parsed = specRow ? deliverySpecSchema.parse(JSON.parse(specRow.spec_json)) : null;
    verificationFocus = parsed?.handoff.verificationFocus || [];
    expectedCriteria = parsed
      ? [{
            id: 'unit-acceptance',
            description: parsed.unit.acceptance,
            oracle: parsed.unit.observableOutcome,
          }, ...verificationFocus.map((focus) => ({
            id: focus.key,
            description: focus.expected,
            oracle: focus.oracle,
          }))]
      : [];
  } catch {
    // saveDeliverySpec validates JSON before persistence; retain a useful validation error below.
  }
  return {
    header,
    criteria,
    checks,
    risks,
    runtimeInputs: runtimeInputs.map((item) => ({
      ...item,
      answer: answerMap.get(item.request_key)?.answer || null,
      answerStatus: answerMap.get(item.request_key)?.status || null,
    })),
    recoveryChecks,
    activeRecoveries,
    expectedCriteria,
    verificationFocus,
  };
}

type VerificationState = ReturnType<typeof state>;
type TerminalAction = 'pass' | 'fail' | 'block' | 'request-input';

function validationErrors(current: VerificationState, terminal: TerminalAction | null = null) {
  const errors: string[] = [];
  if (!current.header.summary?.trim()) errors.push('缺少验证结论摘要');
  if (!current.expectedCriteria.length) errors.push('当前交付单元没有可读取的已收敛交付规格验收标准');
  const expectedKeys = new Set(current.expectedCriteria.map((item) => item.id));
  const unknownCriteria = current.criteria
    .map((item) => item.criterion_key)
    .filter((key) => !expectedKeys.has(key));
  if (unknownCriteria.length) errors.push(`验证记录引用了不存在的验收标准：${unknownCriteria.join(', ')}`);
  const unknownRecoveries = current.recoveryChecks
    .map((item) => item.recovery_id)
    .filter((id) => !current.activeRecoveries.some((recovery) => recovery.recovery_id === id));
  if (unknownRecoveries.length) errors.push(`验证记录引用了非活动恢复事项：${unknownRecoveries.join(', ')}`);

  if (terminal === 'pass' || terminal === 'fail' || terminal === 'block') {
    const missingCriteria = current.expectedCriteria
      .map((item) => item.id)
      .filter((key) => !current.criteria.some((item) => item.criterion_key === key));
    if (missingCriteria.length) errors.push(`以下验收标准尚未逐条记录：${missingCriteria.join(', ')}`);
    if (!current.checks.length) errors.push('至少需要一条独立验证检查');
    if (current.runtimeInputs.some((item) => !item.answer)) {
      errors.push('仍有未回答的运行信息请求，不能提交验证结论');
    }
  }
  if (terminal === 'pass') {
    const notPassed = current.criteria.filter((item) => item.status !== 'passed');
    if (notPassed.length) errors.push(`以下验收标准没有通过：${notPassed.map((item) => item.criterion_key).join(', ')}`);
    const failedChecks = current.checks.filter((item) => !item.passed);
    if (failedChecks.length) errors.push(`仍有失败检查：${failedChecks.map((item) => item.check_key).join(', ')}`);
    const missingRecoveries = current.activeRecoveries.filter((recovery) =>
      !current.recoveryChecks.some((item) =>
        item.recovery_id === recovery.recovery_id && item.status === 'verified'));
    if (missingRecoveries.length) {
      errors.push(`以下活动恢复事项尚未独立验证通过：${missingRecoveries.map((item) => item.recovery_id).join(', ')}`);
    }
    if (current.header.failure_kind || current.header.expected_behavior || current.header.actual_behavior) {
      errors.push('通过结论不应保留失败分类、期望或实际行为');
    }
  }
  if (terminal === 'fail') {
    if (!['implementation', 'specification'].includes(current.header.failure_kind || '')) {
      errors.push('回流失败必须分类为 implementation 或 specification');
    }
    if (!current.header.expected_behavior?.trim()) errors.push('缺少失败场景的期望行为');
    if (!current.header.actual_behavior?.trim()) errors.push('缺少失败场景的实际行为');
    if (!current.criteria.some((item) => item.status === 'failed') && !current.checks.some((item) => !item.passed)) {
      errors.push('回流失败至少需要一个失败验收标准或失败检查');
    }
  }
  if (terminal === 'block') {
    if (!['environment', 'inconclusive'].includes(current.header.failure_kind || '')) {
      errors.push('阻塞结论必须分类为 environment 或 inconclusive');
    }
    if (!current.header.expected_behavior?.trim()) errors.push('缺少无法验证时的期望条件');
    if (!current.header.actual_behavior?.trim()) errors.push('缺少当前实际环境或证据状态');
    if (!current.checks.some((item) => !item.passed)) {
      errors.push('阻塞结论至少需要一个失败检查作为证据');
    }
  }
  if (terminal === 'request-input') {
    const unanswered = current.runtimeInputs.filter((item) => !item.answer);
    if (!unanswered.length) errors.push('没有待用户补充的运行信息，不能 request-input');
  }
  return [...new Set(errors)];
}

function renderStatus(draft: VerificationDraftRow, current: VerificationState) {
  const lines = [
    `验证草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    `结论摘要：${current.header.summary || '未填写'}`,
    `失败分类：${current.header.failure_kind || '未设置'}`,
    `验收覆盖：${current.criteria.length}/${current.expectedCriteria.length}`,
    `独立检查：${current.checks.length}（通过 ${current.checks.filter((item) => item.passed).length} / 失败 ${current.checks.filter((item) => !item.passed).length}）`,
    `风险：${current.risks.length}`,
    `运行信息：${current.runtimeInputs.length}（已回答 ${current.runtimeInputs.filter((item) => item.answer).length}）`,
    `活动恢复事项：${current.activeRecoveries.length}（已记录 ${current.recoveryChecks.length}）`,
  ];
  if (current.expectedCriteria.length) {
    lines.push('', '验收标准（criterion key 必须复用规格 ID）：');
    for (const criterion of current.expectedCriteria) {
      const evidence = current.criteria.find((item) => item.criterion_key === criterion.id);
      lines.push(`- ${criterion.id}：${criterion.description} · ${evidence ? `${evidence.status} · ${evidence.method} · ${evidence.evidence}` : '尚未记录'}`);
    }
  }
  if (current.verificationFocus.length) {
    lines.push('', '额外验证关注点：');
    for (const focus of current.verificationFocus) {
      lines.push(`- ${focus.key}：${focus.expected} · Oracle：${focus.oracle}`);
    }
  }
  if (current.checks.length) {
    lines.push('', '独立检查：', ...current.checks.map((item) =>
      `- ${item.check_key} · ${item.kind} · ${item.passed ? '通过' : '失败'}：${item.summary}`));
  }
  if (current.activeRecoveries.length) {
    lines.push('', '必须核验的活动恢复事项：');
    for (const recovery of current.activeRecoveries) {
      const evidence = current.recoveryChecks.find((item) => item.recovery_id === recovery.recovery_id);
      lines.push(`- ${recovery.recovery_id} · ${recovery.target_stage}：${recovery.summary} · ${evidence ? `${evidence.status} · ${evidence.evidence}` : '尚未记录'}`);
    }
  }
  if (current.runtimeInputs.length) {
    lines.push('', '运行信息（request key 跨轮次不可改名）：');
    for (const input of current.runtimeInputs) {
      lines.push(`- ${input.request_key}：${input.title} · ${input.answer ? `已回答=${input.answer}` : '待回答'}`);
    }
  }
  const commonErrors = validationErrors(current);
  if (commonErrors.length) {
    lines.push('', '当前基础校验提示：', ...commonErrors.map((item, index) => `${index + 1}. ${item}`));
  } else {
    lines.push('', '基础结构已建立；请按实际证据选择 pass、fail、block 或 request-input。');
  }
  return lines.join('\n');
}

function renderArtifact(current: VerificationState, action: TerminalAction) {
  const verdict = action === 'pass' ? '通过' : action === 'fail' ? '失败并回流' : action === 'block' ? '无法完成验证' : '等待运行信息';
  const lines = [
    '# 验证报告',
    '',
    `## 结论：${verdict}`,
    '',
    current.header.summary || '',
    '',
    '## 验收标准证据',
    '',
    ...current.expectedCriteria.map((criterion) => {
      const evidence = current.criteria.find((item) => item.criterion_key === criterion.id);
      return `- **${criterion.id}** ${criterion.description}：${evidence?.status || 'not_tested'}${evidence ? ` · ${evidence.method} — ${evidence.evidence}` : ''}`;
    }),
    '',
    '## 独立检查',
    '',
    ...(current.checks.length
      ? current.checks.map((item) =>
        `- ${item.passed ? '通过' : '失败'} **${item.check_key}**（${item.kind}）：${item.summary}${item.command ? `；命令 \`${item.command}\`` : ''}${item.exit_code !== null ? `；exit=${item.exit_code}` : ''}`)
      : ['- 尚无检查记录']),
  ];
  if (current.header.failure_kind) {
    lines.push(
      '',
      '## 失败归因',
      '',
      `- 分类：${current.header.failure_kind}`,
      `- 期望：${current.header.expected_behavior || ''}`,
      `- 实际：${current.header.actual_behavior || ''}`,
    );
  }
  if (current.recoveryChecks.length) {
    lines.push('', '## 恢复事项验证', '');
    for (const item of current.recoveryChecks) {
      lines.push(`- **${item.recovery_id}**：${item.status} — ${item.evidence}`);
    }
  }
  lines.push('', '## 残余风险', '');
  lines.push(...(current.risks.length ? current.risks.map((item) => `- ${item.content}`) : ['- 未发现已知残余风险']));
  return lines.join('\n');
}

function buildResult(current: VerificationState, draft: VerificationDraftRow, action: TerminalAction) {
  const failureKind = current.header.failure_kind || undefined;
  const result = {
    outcome: action === 'request-input'
      ? 'needs_input' as const
      : action === 'block'
        ? 'failed' as const
        : 'completed' as const,
    summary: current.header.summary!,
    artifact: {
      title: '验证报告',
      content: renderArtifact(current, action),
    },
    ...(action === 'pass' ? { verdict: 'passed' as const } : {}),
    ...(action === 'fail' || action === 'block'
      ? {
        verdict: 'failed' as const,
        failureKind,
        ...(action === 'fail'
          ? {
            rewindTo: failureKind === 'specification' ? 'analysis' as const : 'dev' as const,
            rewindDeliveryUnit: draft.story_index || undefined,
          }
          : {}),
      }
      : {}),
    runtimeInputs: action === 'request-input'
      ? current.runtimeInputs.filter((item) => !item.answer).map((item) => ({
        key: item.request_key,
        title: item.title,
        question: item.question,
        why: item.why,
        recommendation: item.recommendation,
      }))
      : [],
    tests: current.checks.map((item) => ({
      command: item.command || `[${item.kind}] ${item.instruction}`,
      passed: Boolean(item.passed),
      summary: `${item.summary}${item.exit_code !== null ? `（exit=${item.exit_code}）` : ''}`,
    })),
  };
  return agentResultSchema.parse(result);
}

function terminalSubmit(
  db: Db,
  draft: VerificationDraftRow,
  execution: VerificationExecutionRow,
  action: TerminalAction,
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft);
  const errors = validationErrors(current, action);
  if (errors.length) {
    throw new Error(`验证草稿不能执行 ${action}：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  const result = buildResult(current, draft, action);
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
  return action === 'pass'
    ? '验证通过结果已提交。'
    : action === 'fail'
      ? '验证失败与回流证据已提交。'
      : action === 'block'
        ? '验证阻塞证据已提交。'
        : '运行信息请求已提交，等待用户补充。';
}

export function verificationHelp(terminalActions: string[]) {
  return [
    '  verification status',
    '  verification summary set --text <结论摘要>',
    '  verification criterion upsert --key <规格 criterion id> --status <passed|failed|not-tested> --method <command|browser|inspection> --evidence <证据>',
    '  verification criterion remove --key <规格 criterion id>',
    '  verification check upsert --key <稳定 key> --kind <command|browser|inspection> --instruction <检查说明> [--command <真实命令>] --passed <true|false> [--exit-code <整数>] --summary <结果>',
    '  verification check remove --key <稳定 key>',
    '  verification risk upsert --key <稳定 key> --content <残余风险>',
    '  verification risk remove --key <稳定 key>',
    '  verification failure set --kind <implementation|specification|environment|inconclusive> --expected <期望> --actual <实际>',
    '  verification failure clear',
    '  verification runtime-input upsert --key <稳定 key> --title <标题> --question <问题> --why <原因> --recommendation <建议>',
    '  verification runtime-input remove --key <稳定 key>',
    '  verification recovery upsert --id <RECOVERY id> --status <verified|still-failing> --evidence <独立证据>',
    '  verification recovery remove --id <RECOVERY id>',
    ...terminalActions.map((action) => `  ${action}`),
  ];
}

export function runVerificationCommand(input: {
  db: Db;
  execution: VerificationExecutionRow;
  draft: VerificationDraftRow;
  command: string;
  flags: FlagMap;
}) {
  const { db, execution, draft, command, flags } = input;
  if (command === 'verification status') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    return renderStatus({ ...draft, status_viewed_execution_id: execution.execution_id }, state(db, draft));
  }
  if (
    ['verification pass', 'verification fail', 'verification block', 'verification request-input'].includes(command)
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === command.replace('verification ', '')
  ) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);

  if (command === 'verification summary set') {
    db.prepare('UPDATE verification_drafts SET summary = ? WHERE draft_id = ?')
      .run(bounded(required(flags, 'text'), '结论摘要', 10000), draft.draft_id);
    touchDraft(db, draft.draft_id);
    return '验证结论摘要已保存。';
  }
  if (command === 'verification criterion upsert') {
    const key = bounded(required(flags, 'key'), '验收标准 key', 120);
    const status = required(flags, 'status').replace('-', '_');
    if (!['passed', 'failed', 'not_tested'].includes(status)) {
      throw new Error('--status 必须是 passed、failed 或 not-tested');
    }
    const method = required(flags, 'method');
    if (!['command', 'browser', 'inspection'].includes(method)) {
      throw new Error('--method 必须是 command、browser 或 inspection');
    }
    const ordinal = nextOrdinal(db, 'verification_criteria', draft.draft_id);
    db.prepare(`
      INSERT INTO verification_criteria(draft_id, criterion_key, status, method, evidence, ordinal)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, criterion_key) DO UPDATE SET
        status = excluded.status, method = excluded.method, evidence = excluded.evidence
    `).run(
      draft.draft_id,
      key,
      status,
      method,
      bounded(required(flags, 'evidence'), '验收证据'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `验收证据 ${key} 已保存。`;
  }
  if (command === 'verification criterion remove') {
    db.prepare('DELETE FROM verification_criteria WHERE draft_id = ? AND criterion_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '验收证据已删除。';
  }
  if (command === 'verification check upsert') {
    const key = bounded(required(flags, 'key'), '检查 key', 120);
    const kind = required(flags, 'kind');
    if (!['command', 'browser', 'inspection'].includes(kind)) {
      throw new Error('--kind 必须是 command、browser 或 inspection');
    }
    const commandText = flags.get('command')?.trim() || null;
    if (kind === 'command' && !commandText) throw new Error('command 类型检查必须提供 --command');
    const ordinal = nextOrdinal(db, 'verification_checks', draft.draft_id);
    db.prepare(`
      INSERT INTO verification_checks(
        draft_id, check_key, kind, instruction, command, passed, exit_code, summary, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, check_key) DO UPDATE SET
        kind = excluded.kind, instruction = excluded.instruction, command = excluded.command,
        passed = excluded.passed, exit_code = excluded.exit_code, summary = excluded.summary
    `).run(
      draft.draft_id,
      key,
      kind,
      bounded(required(flags, 'instruction'), '检查说明'),
      commandText,
      booleanFlag(flags, 'passed') ? 1 : 0,
      optionalInteger(flags, 'exit-code'),
      bounded(required(flags, 'summary'), '检查摘要'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `独立检查 ${key} 已保存。`;
  }
  if (command === 'verification check remove') {
    db.prepare('DELETE FROM verification_checks WHERE draft_id = ? AND check_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '独立检查已删除。';
  }
  if (command === 'verification risk upsert') {
    const key = bounded(required(flags, 'key'), '风险 key', 120);
    const ordinal = nextOrdinal(db, 'verification_risks', draft.draft_id);
    db.prepare(`
      INSERT INTO verification_risks(draft_id, risk_key, content, ordinal)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(draft_id, risk_key) DO UPDATE SET content = excluded.content
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'content'), '风险内容'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `残余风险 ${key} 已保存。`;
  }
  if (command === 'verification risk remove') {
    db.prepare('DELETE FROM verification_risks WHERE draft_id = ? AND risk_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '残余风险已删除。';
  }
  if (command === 'verification failure set') {
    const kind = required(flags, 'kind');
    if (!['implementation', 'specification', 'environment', 'inconclusive'].includes(kind)) {
      throw new Error('--kind 必须是 implementation、specification、environment 或 inconclusive');
    }
    db.prepare(`
      UPDATE verification_drafts
      SET failure_kind = ?, expected_behavior = ?, actual_behavior = ?
      WHERE draft_id = ?
    `).run(
      kind,
      bounded(required(flags, 'expected'), '期望行为'),
      bounded(required(flags, 'actual'), '实际行为'),
      draft.draft_id,
    );
    touchDraft(db, draft.draft_id);
    return `失败分类 ${kind} 已保存。`;
  }
  if (command === 'verification failure clear') {
    db.prepare(`
      UPDATE verification_drafts
      SET failure_kind = NULL, expected_behavior = NULL, actual_behavior = NULL
      WHERE draft_id = ?
    `).run(draft.draft_id);
    touchDraft(db, draft.draft_id);
    return '失败分类已清除。';
  }
  if (command === 'verification runtime-input upsert') {
    const key = bounded(required(flags, 'key'), '运行信息 key', 120);
    const ordinal = nextOrdinal(db, 'verification_runtime_inputs', draft.draft_id);
    db.prepare(`
      INSERT INTO verification_runtime_inputs(
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
  if (command === 'verification runtime-input remove') {
    const key = required(flags, 'key');
    const answered = state(db, draft).runtimeInputs.find((item) => item.request_key === key)?.answer;
    if (answered) throw new Error(`运行信息 ${key} 已回答，必须保留原 request key 并消费回答`);
    db.prepare('DELETE FROM verification_runtime_inputs WHERE draft_id = ? AND request_key = ?')
      .run(draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return '运行信息请求已删除。';
  }
  if (command === 'verification recovery upsert') {
    const id = bounded(required(flags, 'id'), '恢复事项 id', 200);
    const status = required(flags, 'status').replace('-', '_');
    if (!['verified', 'still_failing'].includes(status)) {
      throw new Error('--status 必须是 verified 或 still-failing');
    }
    const ordinal = nextOrdinal(db, 'verification_recovery_checks', draft.draft_id);
    db.prepare(`
      INSERT INTO verification_recovery_checks(draft_id, recovery_id, status, evidence, ordinal)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, recovery_id) DO UPDATE SET
        status = excluded.status, evidence = excluded.evidence
    `).run(
      draft.draft_id,
      id,
      status,
      bounded(required(flags, 'evidence'), '恢复验证证据'),
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `恢复事项 ${id} 的验证已保存。`;
  }
  if (command === 'verification recovery remove') {
    db.prepare('DELETE FROM verification_recovery_checks WHERE draft_id = ? AND recovery_id = ?')
      .run(draft.draft_id, required(flags, 'id'));
    touchDraft(db, draft.draft_id);
    return '恢复事项验证已删除。';
  }
  if (command === 'verification pass') return terminalSubmit(db, draft, execution, 'pass');
  if (command === 'verification fail') return terminalSubmit(db, draft, execution, 'fail');
  if (command === 'verification block') return terminalSubmit(db, draft, execution, 'block');
  if (command === 'verification request-input') return terminalSubmit(db, draft, execution, 'request-input');
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}
