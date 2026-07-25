import { agentResultSchema, type SliceSpec } from '../domain/agent-result';
import { databaseConnection } from '../infrastructure/database';

type Db = Awaited<ReturnType<typeof databaseConnection>>;
type FlagMap = Map<string, string>;

export type AnalysisDraftRow = {
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

export type AnalysisExecutionRow = {
  execution_id: string;
};

type DecisionRow = {
  decision_key: string;
  title: string;
  question: string;
  impact: string;
  status: 'resolved_from_context' | 'needs_user_input';
  selected_option_id: string | null;
  source: 'code' | 'user' | 'convention' | null;
  decision_text: string | null;
  rationale: string | null;
  evidence: string | null;
  recommendation_option_id: string | null;
  recommendation_reason: string | null;
  depends_on_json: string;
  ordinal: number;
};

type AnalysisDecision = DecisionRow & {
  options: {
    option_id: string;
    label: string;
    consequence: string;
  }[];
  dependsOn: string[];
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

function assertViewed(draft: AnalysisDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 analysis status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function state(db: Db, draft: AnalysisDraftRow) {
  const header = db.prepare(`
    SELECT goal FROM analysis_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as { goal: string | null };
  const scope = db.prepare(`
    SELECT scope_key, direction, content, ordinal
    FROM analysis_scope_items WHERE draft_id = ? ORDER BY ordinal, scope_key
  `).all(draft.draft_id) as {
    scope_key: string;
    direction: 'included' | 'excluded';
    content: string;
    ordinal: number;
  }[];
  const behaviors = db.prepare(`
    SELECT behavior_key, scenario, expected, ordinal
    FROM analysis_behaviors WHERE draft_id = ? ORDER BY ordinal, behavior_key
  `).all(draft.draft_id) as {
    behavior_key: string;
    scenario: string;
    expected: string;
    ordinal: number;
  }[];
  const decisionRows = db.prepare(`
    SELECT * FROM analysis_decisions WHERE draft_id = ? ORDER BY ordinal, decision_key
  `).all(draft.draft_id) as DecisionRow[];
  const options = db.prepare(`
    SELECT decision_key, option_id, label, consequence, ordinal
    FROM analysis_decision_options WHERE draft_id = ? ORDER BY ordinal, option_id
  `).all(draft.draft_id) as {
    decision_key: string;
    option_id: string;
    label: string;
    consequence: string;
    ordinal: number;
  }[];
  const answerRows = db.prepare(`
    SELECT decision_key, answer
    FROM questions
    WHERE task_id = ? AND story_index = ? AND source_agent = 'analyst-agent'
      AND decision_key IS NOT NULL AND answer IS NOT NULL
    ORDER BY created_at, question_id
  `).all(draft.task_id, draft.story_index) as { decision_key: string; answer: string }[];
  const answerMap = new Map(answerRows.map((row) => [row.decision_key, row.answer]));
  const decisions: AnalysisDecision[] = decisionRows.map((decision) => ({
    ...decision,
    options: options.filter((option) => option.decision_key === decision.decision_key),
    dependsOn: parseStringArray(decision.depends_on_json),
    answer: answerMap.get(decision.decision_key) || null,
  }));
  const criteria = db.prepare(`
    SELECT criterion_key, description, oracle, ordinal
    FROM analysis_acceptance_criteria WHERE draft_id = ? ORDER BY ordinal, criterion_key
  `).all(draft.draft_id) as {
    criterion_key: string;
    description: string;
    oracle: string;
    ordinal: number;
  }[];
  const verification = db.prepare(`
    SELECT verification_key, criterion_key, kind, instruction, command, ordinal
    FROM analysis_verification_steps WHERE draft_id = ? ORDER BY ordinal, verification_key
  `).all(draft.draft_id) as {
    verification_key: string;
    criterion_key: string;
    kind: 'command' | 'browser' | 'inspection';
    instruction: string;
    command: string | null;
    ordinal: number;
  }[];
  const dependencies = db.prepare(`
    SELECT dependency_key, content, ordinal
    FROM analysis_dependencies WHERE draft_id = ? ORDER BY ordinal, dependency_key
  `).all(draft.draft_id) as {
    dependency_key: string;
    content: string;
    ordinal: number;
  }[];
  const budget = db.prepare(`
    SELECT budget_key, kind, content, ordinal
    FROM analysis_budget_items WHERE draft_id = ? ORDER BY ordinal, budget_key
  `).all(draft.draft_id) as {
    budget_key: string;
    kind: 'capability' | 'path';
    content: string;
    ordinal: number;
  }[];
  return {
    header,
    scope,
    behaviors,
    decisions,
    criteria,
    verification,
    dependencies,
    budget,
    answeredKeys: answerRows.map((row) => row.decision_key),
  };
}

type AnalysisState = ReturnType<typeof state>;

function validationErrors(
  current: AnalysisState,
  terminal: 'complete' | 'request-clarification' | null = null,
) {
  const errors: string[] = [];
  if (!current.header.goal?.trim()) errors.push('缺少交付单元目标');
  if (!current.scope.some((item) => item.direction === 'included')) errors.push('至少需要一条 included 范围');
  if (!current.behaviors.length) errors.push('至少需要一个用户可观察行为');
  if (!current.decisions.length) errors.push('必须建立完整决策树，至少记录一个关键决策');
  for (const decision of current.decisions) {
    if (decision.options.length < 2) errors.push(`决策 ${decision.decision_key} 至少需要两个互斥选项`);
    if (decision.status === 'resolved_from_context') {
      if (!decision.selected_option_id) errors.push(`决策 ${decision.decision_key} 缺少 selected option`);
      else if (!decision.options.some((option) => option.option_id === decision.selected_option_id)) {
        errors.push(`决策 ${decision.decision_key} 的 selected option 不存在`);
      }
      if (!decision.source) errors.push(`决策 ${decision.decision_key} 缺少来源`);
      if (!decision.decision_text?.trim()) errors.push(`决策 ${decision.decision_key} 缺少决策正文`);
      if (!decision.rationale?.trim()) errors.push(`决策 ${decision.decision_key} 缺少理由`);
      if (!decision.evidence?.trim()) errors.push(`决策 ${decision.decision_key} 缺少可定位证据`);
    } else {
      if (decision.answer) {
        errors.push(`已回答决策 ${decision.decision_key} 尚未在原 key 上 resolve`);
      }
      if (!decision.recommendation_option_id) errors.push(`未决决策 ${decision.decision_key} 缺少推荐选项`);
      else if (!decision.options.some((option) => option.option_id === decision.recommendation_option_id)) {
        errors.push(`未决决策 ${decision.decision_key} 的推荐选项不存在`);
      }
      if (!decision.recommendation_reason?.trim()) errors.push(`未决决策 ${decision.decision_key} 缺少推荐理由`);
    }
    const unknownDependencies = decision.dependsOn.filter((key) =>
      !current.decisions.some((candidate) => candidate.decision_key === key));
    if (unknownDependencies.length) {
      errors.push(`决策 ${decision.decision_key} 依赖不存在的决策：${unknownDependencies.join(', ')}`);
    }
  }
  const missingAnsweredKeys = current.answeredKeys.filter((key) =>
    !current.decisions.some((decision) => decision.decision_key === key));
  if (missingAnsweredKeys.length) {
    errors.push(`已回答 decision key 必须原样保留：${missingAnsweredKeys.join(', ')}`);
  }
  if (!current.criteria.length) errors.push('至少需要一条可判定验收标准');
  if (!current.verification.length) errors.push('至少需要一个验证步骤');
  for (const criterion of current.criteria) {
    if (!current.verification.some((step) => step.criterion_key === criterion.criterion_key)) {
      errors.push(`验收标准 ${criterion.criterion_key} 缺少验证步骤`);
    }
  }
  for (const step of current.verification) {
    if (step.kind === 'command' && !step.command?.trim()) {
      errors.push(`命令验证 ${step.verification_key} 缺少 command`);
    }
  }
  if (!current.budget.some((item) => item.kind === 'capability')) {
    errors.push('change budget 至少需要一条 capability');
  }
  const unresolved = current.decisions.filter((decision) =>
    decision.status === 'needs_user_input' && !decision.answer);
  if (terminal === 'complete' && current.decisions.some((decision) => decision.status === 'needs_user_input')) {
    errors.push('仍有未解决决策，不能完成方案分析');
  }
  if (terminal === 'request-clarification' && !unresolved.length) {
    errors.push('没有待用户回答的决策，不能请求方案澄清');
  }
  return [...new Set(errors)];
}

function renderStatus(draft: AnalysisDraftRow, current: AnalysisState) {
  const errors = validationErrors(current);
  const lines = [
    `方案规格草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    `目标：${current.header.goal || '未填写'}`,
    `范围：included ${current.scope.filter((item) => item.direction === 'included').length} / excluded ${current.scope.filter((item) => item.direction === 'excluded').length}`,
    `行为：${current.behaviors.length}`,
    `决策：${current.decisions.length}（resolved ${current.decisions.filter((item) => item.status === 'resolved_from_context').length} / 待确认 ${current.decisions.filter((item) => item.status === 'needs_user_input').length}）`,
    `验收标准：${current.criteria.length}`,
    `验证步骤：${current.verification.length}`,
    `依赖：${current.dependencies.length}`,
    `Change Budget：capability ${current.budget.filter((item) => item.kind === 'capability').length} / path ${current.budget.filter((item) => item.kind === 'path').length}`,
  ];
  if (current.decisions.length) {
    lines.push('', '决策索引（decision key 跨轮次不可改名）：');
    for (const decision of current.decisions) {
      const stateLabel = decision.status === 'resolved_from_context'
        ? `已解决=${decision.selected_option_id}`
        : decision.answer
          ? `已回答=${decision.answer}，等待在原 key 上 resolve`
          : '待用户回答';
      lines.push(`- ${decision.decision_key}：${decision.title} · ${stateLabel}`);
    }
  }
  if (current.criteria.length) {
    lines.push('', '验收标准索引（编辑时复用 key）：');
    for (const criterion of current.criteria) {
      lines.push(`- ${criterion.criterion_key}：${criterion.description}（Oracle：${criterion.oracle}）`);
    }
  }
  if (errors.length) {
    lines.push('', '当前校验提示：', ...errors.map((item, index) => `${index + 1}. ${item}`));
  } else {
    lines.push('', '方案规格草稿结构完整。请根据未决决策选择 complete 或 request-clarification。');
  }
  return lines.join('\n');
}

function buildSpec(current: AnalysisState): SliceSpec {
  const unresolved = current.decisions.filter((decision) => decision.status === 'needs_user_input');
  return {
    goal: current.header.goal!,
    scope: {
      included: current.scope.filter((item) => item.direction === 'included').map((item) => item.content),
      excluded: current.scope.filter((item) => item.direction === 'excluded').map((item) => item.content),
    },
    behaviors: current.behaviors.map((behavior) => ({
      scenario: behavior.scenario,
      expected: behavior.expected,
    })),
    decisions: current.decisions
      .filter((decision) => decision.status === 'resolved_from_context')
      .map((decision) => ({
        key: decision.decision_key,
        decision: decision.decision_text!,
        rationale: decision.rationale!,
        source: decision.source!,
      })),
    decisionTree: current.decisions.map((decision) => ({
      key: decision.decision_key,
      question: decision.question,
      impact: decision.impact,
      options: decision.options.map((option) => ({
        id: option.option_id,
        label: option.label,
        consequences: [option.consequence],
      })),
      ...(decision.status === 'resolved_from_context'
        ? {
            status: 'resolved_from_context' as const,
            selectedOption: decision.selected_option_id!,
            source: decision.source!,
            evidence: [decision.evidence!],
          }
        : { status: 'needs_user_input' as const }),
    })),
    ambiguities: unresolved.map((decision) => ({
      key: decision.decision_key,
      description: decision.question,
    })),
    acceptanceCriteria: current.criteria.map((criterion) => ({
      id: criterion.criterion_key,
      description: criterion.description,
      oracle: criterion.oracle,
    })),
    verificationPlan: current.verification.map((step) =>
      step.kind === 'command'
        ? {
            criterionId: step.criterion_key,
            kind: 'command' as const,
            instruction: step.instruction,
            command: step.command!,
          }
        : {
            criterionId: step.criterion_key,
            kind: step.kind,
            instruction: step.instruction,
            ...(step.command ? { command: step.command } : {}),
          }),
    dependencies: current.dependencies.map((item) => item.content),
    changeBudget: {
      capabilities: current.budget.filter((item) => item.kind === 'capability').map((item) => item.content),
      paths: current.budget.filter((item) => item.kind === 'path').map((item) => item.content),
    },
  };
}

function renderArtifact(current: AnalysisState) {
  const spec = buildSpec(current);
  const lines = [
    '# 交付单元方案分析',
    '',
    '## 目标',
    '',
    spec.goal,
    '',
    '## 范围',
    '',
    '### 包含',
    ...spec.scope.included.map((item) => `- ${item}`),
    '',
    '### 不包含',
    ...(spec.scope.excluded.length ? spec.scope.excluded.map((item) => `- ${item}`) : ['- 无']),
    '',
    '## 用户可观察行为',
    '',
    ...spec.behaviors.map((item) => `- **${item.scenario}**：${item.expected}`),
    '',
    '## 决策树',
    '',
    ...current.decisions.map((decision) => {
      const selected = decision.status === 'resolved_from_context'
        ? `已选择 ${decision.selected_option_id}：${decision.decision_text}（${decision.rationale}）`
        : '等待用户确认';
      return `- **${decision.decision_key} · ${decision.title}**：${decision.question}\n  - 影响：${decision.impact}\n  - 状态：${selected}`;
    }),
    '',
    '## 验收与验证',
    '',
    ...spec.acceptanceCriteria.map((criterion) => {
      const steps = spec.verificationPlan.filter((step) => step.criterionId === criterion.id);
      return `- **${criterion.id}**：${criterion.description}\n  - Oracle：${criterion.oracle}\n  - 验证：${steps.map((step) => `${step.kind} · ${step.instruction}${step.command ? ` · ${step.command}` : ''}`).join('；')}`;
    }),
    '',
    '## 依赖',
    '',
    ...(spec.dependencies.length ? spec.dependencies.map((item) => `- ${item}`) : ['- 无']),
    '',
    '## Change Budget',
    '',
    ...spec.changeBudget.capabilities.map((item) => `- 能力：${item}`),
    ...spec.changeBudget.paths.map((item) => `- 路径：${item}`),
  ];
  return lines.join('\n');
}

function buildResult(current: AnalysisState, action: 'complete' | 'request-clarification') {
  const complete = action === 'complete';
  const questions = current.decisions
    .filter((decision) => decision.status === 'needs_user_input' && !decision.answer)
    .map((decision) => {
      const recommended = decision.options.find((option) =>
        option.option_id === decision.recommendation_option_id)!;
      return {
        decisionKey: decision.decision_key,
        title: decision.title,
        question: decision.question,
        why: decision.impact,
        recommendation: recommended.label,
        recommendationReason: decision.recommendation_reason!,
        alternatives: decision.options.map((option) => ({
          id: option.option_id,
          label: option.label,
          consequences: [option.consequence],
        })),
        dependsOn: decision.dependsOn,
      };
    });
  return agentResultSchema.parse({
    outcome: complete ? 'completed' : 'needs_input',
    summary: complete
      ? '交付单元方案已形成完整、可验证且没有未决设计歧义的规格'
      : `方案分析仍有 ${questions.length} 个关键决策需要用户确认`,
    artifact: {
      title: complete ? '交付单元方案与验收规格' : '交付单元方案草稿',
      content: renderArtifact(current),
    },
    spec: buildSpec(current),
    questions,
  });
}

function submit(
  db: Db,
  draft: AnalysisDraftRow,
  execution: AnalysisExecutionRow,
  action: 'complete' | 'request-clarification',
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft);
  const errors = validationErrors(current, action);
  if (errors.length) {
    throw new Error(`方案规格草稿不能执行 ${action}：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
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
    ? '方案规格已提交成功。普通最终回复不再用于推进流程，可以结束本轮。'
    : '方案澄清问题已提交成功。普通最终回复不再用于推进流程，可以结束本轮。';
}

export function analysisHelp(terminalActions: string[]) {
  return [
    '  analysis goal set --text <交付单元目标>',
    '  analysis scope upsert --key <key> --direction <included|excluded> --content <范围>',
    '  analysis scope remove --key <key>',
    '  analysis behavior upsert --key <key> --scenario <场景> --expected <可观察结果>',
    '  analysis behavior remove --key <key>',
    '  analysis decision upsert --key <decisionKey> --title <标题> --question <决策问题> --impact <影响>',
    '  analysis decision option-upsert --key <decisionKey> --id <选项id> --label <名称> --consequence <后果>',
    '  analysis decision option-remove --key <decisionKey> --id <选项id>',
    '  analysis decision recommend --key <decisionKey> --option <选项id> --reason <推荐理由>',
    '  analysis decision depends-add --key <decisionKey> --on <依赖decisionKey>',
    '  analysis decision depends-remove --key <decisionKey> --on <依赖decisionKey>',
    '  analysis decision resolve --key <decisionKey> --option <选项id> --source <code|user|convention> --decision <结论> --rationale <理由> --evidence <证据>',
    '  analysis decision reopen --key <decisionKey>',
    '  analysis decision remove --key <decisionKey>',
    '  analysis criterion upsert --key <key> --description <验收标准> --oracle <判定方法>',
    '  analysis criterion remove --key <key>',
    '  analysis verification upsert --key <key> --criterion <criterionKey> --kind <command|browser|inspection> --instruction <步骤> [--command <命令>]',
    '  analysis verification remove --key <key>',
    '  analysis dependency upsert --key <key> --content <依赖>',
    '  analysis dependency remove --key <key>',
    '  analysis budget upsert --key <key> --kind <capability|path> --content <边界>',
    '  analysis budget remove --key <key>',
    '  analysis validate',
    '',
    '终止命令：',
    ...terminalActions.map((action) => `  ${action}`),
  ];
}

export function runAnalysisCommand(input: {
  db: Db;
  execution: AnalysisExecutionRow;
  draft: AnalysisDraftRow;
  command: string;
  flags: FlagMap;
}) {
  const { db, execution, command, flags } = input;
  let { draft } = input;
  if (command === 'analysis status') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    draft = { ...draft, status_viewed_execution_id: execution.execution_id };
    return renderStatus(draft, state(db, draft));
  }
  const action = command === 'analysis complete'
    ? 'complete'
    : command === 'analysis request-clarification'
      ? 'request-clarification'
      : null;
  if (action && draft.terminal_execution_id === execution.execution_id && draft.terminal_action === action) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);

  if (command === 'analysis goal set') {
    db.prepare('UPDATE analysis_drafts SET goal = ? WHERE draft_id = ?')
      .run(bounded(required(flags, 'text'), '交付单元目标'), draft.draft_id);
    touchDraft(db, draft.draft_id);
    return '交付单元目标已保存。';
  }
  if (command === 'analysis scope upsert') {
    const direction = required(flags, 'direction');
    if (!['included', 'excluded'].includes(direction)) {
      throw new Error('范围 direction 必须是 included 或 excluded');
    }
    const key = bounded(required(flags, 'key'), '范围 key', 120);
    db.prepare(`
      INSERT INTO analysis_scope_items(draft_id, scope_key, direction, content, ordinal)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, scope_key) DO UPDATE SET
        direction = excluded.direction, content = excluded.content
    `).run(
      draft.draft_id,
      key,
      direction,
      bounded(required(flags, 'content'), '范围内容'),
      nextOrdinal(db, 'analysis_scope_items', draft.draft_id),
    );
    touchDraft(db, draft.draft_id);
    return `范围 ${key} 已保存。`;
  }
  if (command === 'analysis scope remove') {
    db.prepare('DELETE FROM analysis_scope_items WHERE draft_id = ? AND scope_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '范围项已删除。';
  }
  if (command === 'analysis behavior upsert') {
    const key = bounded(required(flags, 'key'), '行为 key', 120);
    db.prepare(`
      INSERT INTO analysis_behaviors(draft_id, behavior_key, scenario, expected, ordinal)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, behavior_key) DO UPDATE SET
        scenario = excluded.scenario, expected = excluded.expected
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'scenario'), '行为场景'),
      bounded(required(flags, 'expected'), '预期行为'),
      nextOrdinal(db, 'analysis_behaviors', draft.draft_id),
    );
    touchDraft(db, draft.draft_id);
    return `行为 ${key} 已保存。`;
  }
  if (command === 'analysis behavior remove') {
    db.prepare('DELETE FROM analysis_behaviors WHERE draft_id = ? AND behavior_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '行为已删除。';
  }
  if (command === 'analysis decision upsert') {
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    db.prepare(`
      INSERT INTO analysis_decisions(
        draft_id, decision_key, title, question, impact, status, ordinal
      ) VALUES(?, ?, ?, ?, ?, 'needs_user_input', ?)
      ON CONFLICT(draft_id, decision_key) DO UPDATE SET
        title = excluded.title, question = excluded.question, impact = excluded.impact
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'title'), '决策标题', 500),
      bounded(required(flags, 'question'), '决策问题'),
      bounded(required(flags, 'impact'), '决策影响'),
      nextOrdinal(db, 'analysis_decisions', draft.draft_id),
    );
    touchDraft(db, draft.draft_id);
    return `决策 ${key} 已保存。`;
  }
  if (command === 'analysis decision option-upsert') {
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    const exists = db.prepare(`
      SELECT 1 FROM analysis_decisions WHERE draft_id = ? AND decision_key = ?
    `).get(draft.draft_id, key);
    if (!exists) throw new Error(`决策 ${key} 不存在，请先使用 decision upsert`);
    const optionId = bounded(required(flags, 'id'), '选项 id', 100);
    db.prepare(`
      INSERT INTO analysis_decision_options(
        draft_id, decision_key, option_id, label, consequence, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, decision_key, option_id) DO UPDATE SET
        label = excluded.label, consequence = excluded.consequence
    `).run(
      draft.draft_id,
      key,
      optionId,
      bounded(required(flags, 'label'), '选项名称', 500),
      bounded(required(flags, 'consequence'), '选项后果'),
      nextOrdinal(db, 'analysis_decision_options', draft.draft_id),
    );
    touchDraft(db, draft.draft_id);
    return `决策 ${key} 的选项 ${optionId} 已保存。`;
  }
  if (command === 'analysis decision option-remove') {
    db.prepare(`
      DELETE FROM analysis_decision_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).run(draft.draft_id, required(flags, 'key'), required(flags, 'id'));
    touchDraft(db, draft.draft_id);
    return '决策选项已删除。';
  }
  if (command === 'analysis decision recommend') {
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    const option = bounded(required(flags, 'option'), '推荐选项', 100);
    const exists = db.prepare(`
      SELECT 1 FROM analysis_decision_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).get(draft.draft_id, key, option);
    if (!exists) throw new Error(`决策 ${key} 不存在选项 ${option}`);
    db.prepare(`
      UPDATE analysis_decisions
      SET recommendation_option_id = ?, recommendation_reason = ?
      WHERE draft_id = ? AND decision_key = ?
    `).run(option, bounded(required(flags, 'reason'), '推荐理由'), draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return `决策 ${key} 的推荐答案已保存。`;
  }
  if (command === 'analysis decision depends-add' || command === 'analysis decision depends-remove') {
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    const dependency = bounded(required(flags, 'on'), '依赖 decision key', 120);
    if (key === dependency) throw new Error('决策不能依赖自身');
    const row = db.prepare(`
      SELECT depends_on_json FROM analysis_decisions
      WHERE draft_id = ? AND decision_key = ?
    `).get(draft.draft_id, key) as { depends_on_json: string } | undefined;
    if (!row) throw new Error(`决策 ${key} 不存在`);
    const values = parseStringArray(row.depends_on_json);
    const next = command.endsWith('depends-add')
      ? [...new Set([...values, dependency])]
      : values.filter((item) => item !== dependency);
    db.prepare(`
      UPDATE analysis_decisions SET depends_on_json = ?
      WHERE draft_id = ? AND decision_key = ?
    `).run(JSON.stringify(next), draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return `决策 ${key} 的依赖已更新。`;
  }
  if (command === 'analysis decision resolve') {
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    const option = bounded(required(flags, 'option'), '选中选项', 100);
    const source = required(flags, 'source');
    if (!['code', 'user', 'convention'].includes(source)) {
      throw new Error('决策 source 必须是 code、user 或 convention');
    }
    const exists = db.prepare(`
      SELECT 1 FROM analysis_decision_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).get(draft.draft_id, key, option);
    if (!exists) throw new Error(`决策 ${key} 不存在选项 ${option}`);
    db.prepare(`
      UPDATE analysis_decisions
      SET status = 'resolved_from_context', selected_option_id = ?, source = ?,
          decision_text = ?, rationale = ?, evidence = ?
      WHERE draft_id = ? AND decision_key = ?
    `).run(
      option,
      source,
      bounded(required(flags, 'decision'), '决策正文'),
      bounded(required(flags, 'rationale'), '决策理由'),
      bounded(required(flags, 'evidence'), '决策证据'),
      draft.draft_id,
      key,
    );
    touchDraft(db, draft.draft_id);
    return `决策 ${key} 已在原 key 上解决。`;
  }
  if (command === 'analysis decision reopen') {
    db.prepare(`
      UPDATE analysis_decisions
      SET status = 'needs_user_input', selected_option_id = NULL, source = NULL,
          decision_text = NULL, rationale = NULL, evidence = NULL
      WHERE draft_id = ? AND decision_key = ?
    `).run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '决策已重新打开。';
  }
  if (command === 'analysis decision remove') {
    const key = required(flags, 'key');
    const answered = db.prepare(`
      SELECT 1 FROM questions
      WHERE task_id = ? AND story_index = ? AND source_agent = 'analyst-agent'
        AND decision_key = ? AND answer IS NOT NULL
      LIMIT 1
    `).get(draft.task_id, draft.story_index, key);
    if (answered) throw new Error(`决策 ${key} 已有用户回答，必须保留原 decision key，不能删除`);
    db.prepare('DELETE FROM analysis_decisions WHERE draft_id = ? AND decision_key = ?')
      .run(draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return '决策已删除。';
  }
  if (command === 'analysis criterion upsert') {
    const key = bounded(required(flags, 'key'), 'criterion key', 120);
    db.prepare(`
      INSERT INTO analysis_acceptance_criteria(
        draft_id, criterion_key, description, oracle, ordinal
      ) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, criterion_key) DO UPDATE SET
        description = excluded.description, oracle = excluded.oracle
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'description'), '验收标准'),
      bounded(required(flags, 'oracle'), '验收 Oracle'),
      nextOrdinal(db, 'analysis_acceptance_criteria', draft.draft_id),
    );
    touchDraft(db, draft.draft_id);
    return `验收标准 ${key} 已保存。`;
  }
  if (command === 'analysis criterion remove') {
    db.prepare(`
      DELETE FROM analysis_acceptance_criteria WHERE draft_id = ? AND criterion_key = ?
    `).run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '验收标准已删除。';
  }
  if (command === 'analysis verification upsert') {
    const key = bounded(required(flags, 'key'), 'verification key', 120);
    const criterion = bounded(required(flags, 'criterion'), 'criterion key', 120);
    const kind = required(flags, 'kind');
    if (!['command', 'browser', 'inspection'].includes(kind)) {
      throw new Error('验证 kind 必须是 command、browser 或 inspection');
    }
    const criterionExists = db.prepare(`
      SELECT 1 FROM analysis_acceptance_criteria
      WHERE draft_id = ? AND criterion_key = ?
    `).get(draft.draft_id, criterion);
    if (!criterionExists) throw new Error(`验收标准 ${criterion} 不存在`);
    const executable = flags.get('command')?.trim() || null;
    if (kind === 'command' && !executable) throw new Error('command 类型验证必须提供 --command');
    db.prepare(`
      INSERT INTO analysis_verification_steps(
        draft_id, verification_key, criterion_key, kind, instruction, command, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, verification_key) DO UPDATE SET
        criterion_key = excluded.criterion_key, kind = excluded.kind,
        instruction = excluded.instruction, command = excluded.command
    `).run(
      draft.draft_id,
      key,
      criterion,
      kind,
      bounded(required(flags, 'instruction'), '验证步骤'),
      executable,
      nextOrdinal(db, 'analysis_verification_steps', draft.draft_id),
    );
    touchDraft(db, draft.draft_id);
    return `验证步骤 ${key} 已保存。`;
  }
  if (command === 'analysis verification remove') {
    db.prepare(`
      DELETE FROM analysis_verification_steps WHERE draft_id = ? AND verification_key = ?
    `).run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '验证步骤已删除。';
  }
  if (command === 'analysis dependency upsert') {
    const key = bounded(required(flags, 'key'), '依赖 key', 120);
    db.prepare(`
      INSERT INTO analysis_dependencies(draft_id, dependency_key, content, ordinal)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(draft_id, dependency_key) DO UPDATE SET content = excluded.content
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'content'), '依赖内容'),
      nextOrdinal(db, 'analysis_dependencies', draft.draft_id),
    );
    touchDraft(db, draft.draft_id);
    return `依赖 ${key} 已保存。`;
  }
  if (command === 'analysis dependency remove') {
    db.prepare('DELETE FROM analysis_dependencies WHERE draft_id = ? AND dependency_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '依赖已删除。';
  }
  if (command === 'analysis budget upsert') {
    const key = bounded(required(flags, 'key'), 'budget key', 120);
    const kind = required(flags, 'kind');
    if (!['capability', 'path'].includes(kind)) {
      throw new Error('budget kind 必须是 capability 或 path');
    }
    db.prepare(`
      INSERT INTO analysis_budget_items(draft_id, budget_key, kind, content, ordinal)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, budget_key) DO UPDATE SET
        kind = excluded.kind, content = excluded.content
    `).run(
      draft.draft_id,
      key,
      kind,
      bounded(required(flags, 'content'), 'Change Budget 内容', 1000),
      nextOrdinal(db, 'analysis_budget_items', draft.draft_id),
    );
    touchDraft(db, draft.draft_id);
    return `Change Budget ${key} 已保存。`;
  }
  if (command === 'analysis budget remove') {
    db.prepare('DELETE FROM analysis_budget_items WHERE draft_id = ? AND budget_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return 'Change Budget 项已删除。';
  }
  if (command === 'analysis validate') {
    const errors = validationErrors(state(db, draft));
    if (errors.length) throw new Error(`方案规格草稿校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    return '方案规格草稿结构校验通过。';
  }
  if (action) return submit(db, draft, execution, action);
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}

export const analysisCommandDraftInternals = {
  validationErrors,
  buildSpec,
  renderArtifact,
  buildResult,
};
