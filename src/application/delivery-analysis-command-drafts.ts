import { agentResultSchema, type DeliverySpec } from '../domain/agent-result';
import { databaseConnection } from '../infrastructure/database';

type Db = Awaited<ReturnType<typeof databaseConnection>>;
type FlagMap = Map<string, string>;

export type DeliveryAnalysisDraftRow = {
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

export type DeliveryAnalysisExecutionRow = {
  execution_id: string;
};

type DecisionAuthority =
  | 'upstream'
  | 'user'
  | 'project_evidence'
  | 'agent_authority'
  | 'needs_user_input';

function required(flags: FlagMap, name: string) {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

function optional(flags: FlagMap, name: string) {
  return flags.get(name)?.trim() || null;
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

function assertViewed(draft: DeliveryAnalysisDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 delivery-analysis status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function state(db: Db, draft: DeliveryAnalysisDraftRow) {
  const contract = db.prepare(`
    SELECT unit_key, title, actor, trigger_condition, observable_outcome,
           acceptance, summary, implementation_guidance
    FROM delivery_analysis_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    unit_key: string;
    title: string;
    actor: string;
    trigger_condition: string;
    observable_outcome: string;
    acceptance: string;
    summary: string | null;
    implementation_guidance: string | null;
  };
  const sources = db.prepare(`
    SELECT source_key, source_kind, content, source_ref, ordinal
    FROM delivery_analysis_source_items
    WHERE draft_id = ? ORDER BY ordinal, source_key
  `).all(draft.draft_id) as {
    source_key: string;
    source_kind: 'change' | 'preserve' | 'technical' | 'acceptance';
    content: string;
    source_ref: string;
    ordinal: number;
  }[];
  const upstreamDependencies = db.prepare(`
    SELECT story_index, unit_key, title, ordinal
    FROM delivery_analysis_upstream_dependencies
    WHERE draft_id = ? ORDER BY ordinal, story_index
  `).all(draft.draft_id) as {
    story_index: number;
    unit_key: string;
    title: string;
    ordinal: number;
  }[];
  const impactRows = db.prepare(`
    SELECT impact_key, area, finding, disposition, evidence, decision_key, ordinal
    FROM delivery_analysis_impacts
    WHERE draft_id = ? ORDER BY ordinal, impact_key
  `).all(draft.draft_id) as {
    impact_key: string;
    area: string;
    finding: string;
    disposition: 'change' | 'preserve' | 'exclude' | 'needs_decision';
    evidence: string;
    decision_key: string | null;
    ordinal: number;
  }[];
  const decisionRows = db.prepare(`
    SELECT * FROM delivery_analysis_decisions
    WHERE draft_id = ? ORDER BY ordinal, decision_key
  `).all(draft.draft_id) as {
    decision_key: string;
    decision_type: 'business' | 'technical';
    title: string;
    question: string;
    impact: string;
    authority: DecisionAuthority;
    status: 'resolved' | 'needs_user_input';
    selected_option_id: string | null;
    decision_text: string | null;
    rationale: string | null;
    evidence: string | null;
    recommendation_option_id: string | null;
    recommendation_reason: string | null;
    ordinal: number;
  }[];
  const decisionOptions = db.prepare(`
    SELECT decision_key, option_id, label, consequence, ordinal
    FROM delivery_analysis_decision_options
    WHERE draft_id = ? ORDER BY ordinal, option_id
  `).all(draft.draft_id) as {
    decision_key: string;
    option_id: string;
    label: string;
    consequence: string;
    ordinal: number;
  }[];
  const answers = db.prepare(`
    SELECT decision_key, answer
    FROM questions
    WHERE task_id = ? AND story_index = ? AND source_agent = 'analyst-agent'
      AND decision_key IS NOT NULL AND answer IS NOT NULL
    ORDER BY created_at, question_id
  `).all(draft.task_id, draft.story_index) as { decision_key: string; answer: string }[];
  const answerMap = new Map(answers.map((answer) => [answer.decision_key, answer.answer]));
  const decisions = decisionRows.map((decision) => ({
    ...decision,
    options: decisionOptions.filter((option) => option.decision_key === decision.decision_key),
    answer: answerMap.get(decision.decision_key) || null,
  }));
  const guardrails = db.prepare(`
    SELECT guardrail_key, content, rationale, ordinal
    FROM delivery_analysis_guardrails
    WHERE draft_id = ? ORDER BY ordinal, guardrail_key
  `).all(draft.draft_id) as {
    guardrail_key: string;
    content: string;
    rationale: string;
    ordinal: number;
  }[];
  const verificationFocus = db.prepare(`
    SELECT focus_key, expected, oracle, ordinal
    FROM delivery_analysis_verification_focus
    WHERE draft_id = ? ORDER BY ordinal, focus_key
  `).all(draft.draft_id) as {
    focus_key: string;
    expected: string;
    oracle: string;
    ordinal: number;
  }[];
  return {
    contract,
    sources,
    upstreamDependencies,
    impacts: impactRows,
    decisions,
    guardrails,
    verificationFocus,
    answeredKeys: answers.map((answer) => answer.decision_key),
  };
}

export type DeliveryAnalysisState = ReturnType<typeof state>;

export function deliveryAnalysisValidationErrors(
  current: DeliveryAnalysisState,
  terminal: 'complete' | 'request-clarification' | null = null,
) {
  const errors: string[] = [];
  if (!current.contract.summary?.trim()) errors.push('缺少交付分析摘要');
  if (!current.contract.implementation_guidance?.trim()) errors.push('缺少冻结交付契约中的实现方向');
  if (!current.impacts.length) errors.push('至少需要记录一个经过调查的实际影响');

  const decisionKeys = new Set(current.decisions.map((decision) => decision.decision_key));
  for (const impact of current.impacts) {
    if (impact.decision_key && !decisionKeys.has(impact.decision_key)) {
      errors.push(`影响 ${impact.impact_key} 关联了不存在的决策 ${impact.decision_key}`);
    }
    if (impact.disposition === 'needs_decision') {
      if (!impact.decision_key) {
        errors.push(`待决策影响 ${impact.impact_key} 必须关联 decision key`);
      } else {
        const decision = current.decisions.find((item) => item.decision_key === impact.decision_key);
        if (decision?.status !== 'needs_user_input') {
          errors.push(`待决策影响 ${impact.impact_key} 必须关联尚未解决的决策`);
        }
      }
    }
  }

  for (const decision of current.decisions) {
    const optionIds = decision.options.map((option) => option.option_id);
    if (decision.status === 'resolved') {
      if (decision.authority === 'needs_user_input') {
        errors.push(`决策 ${decision.decision_key} 已解决但权限仍为 needs_user_input`);
      }
      if (optionIds.length && !decision.selected_option_id) {
        errors.push(`决策 ${decision.decision_key} 已记录候选选项但缺少选中选项`);
      } else if (decision.selected_option_id && !optionIds.includes(decision.selected_option_id)) {
        errors.push(`决策 ${decision.decision_key} 的选中选项不存在`);
      }
      if (!decision.decision_text?.trim()) errors.push(`决策 ${decision.decision_key} 缺少结论`);
      if (!decision.rationale?.trim()) errors.push(`决策 ${decision.decision_key} 缺少理由`);
      if (!decision.evidence?.trim()) errors.push(`决策 ${decision.decision_key} 缺少证据`);
    } else {
      if (decision.answer) errors.push(`已回答决策 ${decision.decision_key} 尚未在原 key 上解决`);
      if (decision.options.length < 2) {
        errors.push(`待用户确认的决策 ${decision.decision_key} 至少需要两个真实互斥选项`);
      }
      if (!decision.recommendation_option_id) {
        errors.push(`待确认决策 ${decision.decision_key} 缺少推荐选项`);
      } else if (!optionIds.includes(decision.recommendation_option_id)) {
        errors.push(`待确认决策 ${decision.decision_key} 的推荐选项不存在`);
      }
      if (!decision.recommendation_reason?.trim()) {
        errors.push(`待确认决策 ${decision.decision_key} 缺少推荐理由`);
      }
      if (!current.impacts.some((impact) =>
        impact.disposition === 'needs_decision'
        && impact.decision_key === decision.decision_key)) {
        errors.push(`待确认决策 ${decision.decision_key} 没有关联实际影响`);
      }
    }
  }

  const missingAnsweredKeys = current.answeredKeys.filter((key) => !decisionKeys.has(key));
  if (missingAnsweredKeys.length) {
    errors.push(`已回答 decision key 必须原样保留：${missingAnsweredKeys.join(', ')}`);
  }
  for (const key of current.answeredKeys) {
    const decision = current.decisions.find((item) => item.decision_key === key);
    if (decision && (decision.status !== 'resolved' || decision.authority !== 'user')) {
      errors.push(`已回答决策 ${key} 必须在原 key 上以 user 权限关闭`);
    }
  }

  const unresolved = current.decisions.filter((decision) => decision.status === 'needs_user_input');
  if (terminal === 'complete' && unresolved.length) {
    errors.push('仍有待用户确认的关键决策，不能完成交付分析');
  }
  if (terminal === 'complete' && current.impacts.some((impact) => impact.disposition === 'needs_decision')) {
    errors.push('仍有尚未确定处理方式的影响，不能完成交付分析');
  }
  const unanswered = unresolved.filter((decision) => !decision.answer);
  if (terminal === 'request-clarification' && !unanswered.length) {
    errors.push('没有待用户回答的关键决策，不能请求确认');
  }
  return [...new Set(errors)];
}

function renderStatus(draft: DeliveryAnalysisDraftRow, current: DeliveryAnalysisState) {
  const errors = deliveryAnalysisValidationErrors(current);
  const lines = [
    `交付分析草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    `交付单元：${current.contract.unit_key} · ${current.contract.title}`,
    `参与者：${current.contract.actor}`,
    `触发条件：${current.contract.trigger_condition}`,
    `可观察结果：${current.contract.observable_outcome}`,
    `验收语义：${current.contract.acceptance}`,
    `上游来源：${current.sources.length}`,
    `前置交付单元：${current.upstreamDependencies.length}`,
    '',
    `分析摘要：${current.contract.summary ? '已填写' : '未填写'}`,
    `实际影响：${current.impacts.length}（待决策 ${current.impacts.filter((item) => item.disposition === 'needs_decision').length}）`,
    `关键决策：${current.decisions.length}（已关闭 ${current.decisions.filter((item) => item.status === 'resolved').length} / 待确认 ${current.decisions.filter((item) => item.status === 'needs_user_input').length}）`,
    `交付契约：${current.contract.implementation_guidance ? '已填写' : '未填写'}`,
    `保护约束：${current.guardrails.length}`,
    `验证关注点：${current.verificationFocus.length}`,
  ];
  if (current.sources.length) {
    lines.push('', '冻结的上游输入：');
    for (const source of current.sources) {
      lines.push(`- ${source.source_key} · ${source.source_kind} · ${source.content}`);
    }
  }
  if (current.impacts.length) {
    lines.push('', '影响索引：');
    for (const impact of current.impacts) {
      lines.push(`- ${impact.impact_key} · ${impact.disposition} · ${impact.area}${impact.decision_key ? ` · decision=${impact.decision_key}` : ''}`);
    }
  }
  if (current.decisions.length) {
    lines.push('', '决策索引（decision key 跨轮次不可改名）：');
    for (const decision of current.decisions) {
      lines.push(`- ${decision.decision_key} · ${decision.decision_type} · ${decision.status} · ${decision.authority}${decision.answer ? ` · 已回答=${decision.answer}` : ''}`);
    }
  }
  if (errors.length) lines.push('', '当前校验提示：', ...errors.map((error, index) => `${index + 1}. ${error}`));
  else lines.push('', '交付分析草稿已具备提交条件。');
  return lines.join('\n');
}

function buildSpec(current: DeliveryAnalysisState): DeliverySpec {
  return {
    unit: {
      key: current.contract.unit_key,
      title: current.contract.title,
      actor: current.contract.actor,
      trigger: current.contract.trigger_condition,
      observableOutcome: current.contract.observable_outcome,
      acceptance: current.contract.acceptance,
      sourceRefs: current.sources.map((source) => ({
        key: source.source_key,
        kind: source.source_kind,
        content: source.content,
        sourceRef: source.source_ref,
      })),
      dependsOn: current.upstreamDependencies.map((dependency) => dependency.unit_key),
    },
    summary: current.contract.summary!,
    impacts: current.impacts.map((impact) => ({
      key: impact.impact_key,
      area: impact.area,
      finding: impact.finding,
      disposition: impact.disposition,
      evidence: impact.evidence,
      ...(impact.decision_key ? { decisionKey: impact.decision_key } : {}),
    })),
    decisions: current.decisions.map((decision) => ({
      key: decision.decision_key,
      type: decision.decision_type,
      title: decision.title,
      question: decision.question,
      impact: decision.impact,
      options: decision.options.map((option) => ({
        id: option.option_id,
        label: option.label,
        consequences: [option.consequence],
      })),
      ...(decision.status === 'resolved'
        ? {
            status: 'resolved' as const,
            ...(decision.selected_option_id ? { selectedOption: decision.selected_option_id } : {}),
            authority: decision.authority as Exclude<DecisionAuthority, 'needs_user_input'>,
            decision: decision.decision_text!,
            rationale: decision.rationale!,
            evidence: decision.evidence!,
          }
        : {
            status: 'needs_user_input' as const,
            authority: 'needs_user_input' as const,
            recommendationOption: decision.recommendation_option_id!,
            recommendationReason: decision.recommendation_reason!,
          }),
    })),
    handoff: {
      implementationGuidance: current.contract.implementation_guidance!,
      guardrails: current.guardrails.map((guardrail) => ({
        key: guardrail.guardrail_key,
        content: guardrail.content,
        rationale: guardrail.rationale,
      })),
      verificationFocus: current.verificationFocus.map((focus) => ({
        key: focus.focus_key,
        expected: focus.expected,
        oracle: focus.oracle,
      })),
    },
  };
}

function renderArtifact(current: DeliveryAnalysisState) {
  const lines = [
    '# 交付分析',
    '',
    `> ${current.contract.unit_key} · ${current.contract.title}`,
    '',
    '## 交付单元',
    '',
    `- 参与者：${current.contract.actor}`,
    `- 触发条件：${current.contract.trigger_condition}`,
    `- 可观察结果：${current.contract.observable_outcome}`,
    `- 验收语义：${current.contract.acceptance}`,
    '',
    '## 分析结论',
    '',
    current.contract.summary || '',
    '',
    '## 实际影响',
    '',
    ...current.impacts.map((impact) =>
      `- **${impact.impact_key} · ${impact.disposition} · ${impact.area}**：${impact.finding}\n  - 证据：${impact.evidence}${impact.decision_key ? `\n  - 关联决策：${impact.decision_key}` : ''}`),
    '',
    '## 关键决策',
    '',
    ...(current.decisions.length
      ? current.decisions.map((decision) =>
          `- **${decision.decision_key} · ${decision.decision_type} · ${decision.title}**：${decision.decision_text || '等待用户确认'}\n  - 权限：${decision.authority}\n  - 影响：${decision.impact}\n  - 依据：${decision.evidence || decision.recommendation_reason || ''}`)
      : ['- 没有需要单独记录的关键决策。']),
    '',
    '## 交付契约',
    '',
    '### 实现方向',
    '',
    current.contract.implementation_guidance || '',
  ];
  if (current.guardrails.length) {
    lines.push('', '### 保护约束', '', ...current.guardrails.map((guardrail) =>
      `- **${guardrail.guardrail_key}**：${guardrail.content}\n  - 理由：${guardrail.rationale}`));
  }
  lines.push(
    '',
    '### 验证关注点',
    '',
    `- **unit-acceptance**：${current.contract.acceptance}\n  - Oracle：${current.contract.observable_outcome}`,
    ...current.verificationFocus.map((focus) =>
      `- **${focus.focus_key}**：${focus.expected}\n  - Oracle：${focus.oracle}`),
  );
  return lines.join('\n');
}

function buildResult(current: DeliveryAnalysisState, action: 'complete' | 'request-clarification') {
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
        dependsOn: [],
      };
    });
  return agentResultSchema.parse({
    outcome: action === 'complete' ? 'completed' : 'needs_input',
    summary: action === 'complete'
      ? '当前交付单元的真实影响、关键决策和冻结交付契约已经收敛'
      : `交付分析仍有 ${questions.length} 个超出 Agent 权限的关键决策需要用户确认`,
    artifact: {
      title: action === 'complete' ? '交付分析' : '交付分析草稿',
      content: renderArtifact(current),
    },
    spec: buildSpec(current),
    questions,
  });
}

function submit(
  db: Db,
  draft: DeliveryAnalysisDraftRow,
  execution: DeliveryAnalysisExecutionRow,
  action: 'complete' | 'request-clarification',
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft);
  const errors = deliveryAnalysisValidationErrors(current, action);
  if (errors.length) {
    throw new Error(`交付分析草稿不能执行 ${action}：\n${errors.map((error, index) => `${index + 1}. ${error}`).join('\n')}`);
  }
  const result = buildResult(current, action);
  db.transaction(() => {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status = ?, terminal_action = ?, terminal_execution_id = ?,
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(
      action === 'complete' ? 'submitted' : 'waiting_for_answers',
      action,
      execution.execution_id,
      draft.draft_id,
    );
    db.prepare(`
      UPDATE execution_attempts
      SET status = 'output_received', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'running'
    `).run(JSON.stringify(result), execution.execution_id);
  })();
  return action === 'complete'
    ? '交付分析已提交成功。普通最终回复不再用于推进流程，可以结束本轮。'
    : '关键决策确认请求已提交成功。普通最终回复不再用于推进流程，可以结束本轮。';
}

const deliveryAnalysisCommandIndex = [
  '  delivery-analysis summary set --text <影响与决策分析结论>',
  '  delivery-analysis contract set --text <冻结交付契约中的实现方向>',
  '  delivery-analysis impact upsert --key <key> --area <受影响范围> --finding <发现> --disposition <change|preserve|exclude|needs_decision> --evidence <证据> [--decision <decisionKey>]',
  '  delivery-analysis impact remove --key <key>',
  '  delivery-analysis decision upsert --key <key> --type <business|technical> --title <标题> --question <决策问题> --impact <不同选择的影响>',
  '  delivery-analysis decision option-upsert --key <key> --id <选项id> --label <名称> --consequence <后果>',
  '  delivery-analysis decision option-remove --key <key> --id <选项id>',
  '  delivery-analysis decision resolve --key <key> [--option <选项id>] --authority <upstream|user|project_evidence|agent_authority> --decision <结论> --rationale <理由> --evidence <证据>',
  '  delivery-analysis decision ask --key <key> --option <推荐选项id> --reason <推荐理由>',
  '  delivery-analysis decision reopen --key <key>',
  '  delivery-analysis decision remove --key <key>',
  '  delivery-analysis guardrail upsert --key <key> --content <必须保护的约束> --rationale <理由>',
  '  delivery-analysis guardrail remove --key <key>',
  '  delivery-analysis verification-focus upsert --key <key> --expected <重点验证结果> --oracle <判定方法>',
  '  delivery-analysis verification-focus remove --key <key>',
  '  delivery-analysis validate',
];

export function deliveryAnalysisHelp(terminalActions: string[], topic?: string | null) {
  if (topic === 'impact') {
    return [
      '实际影响表示调查后确认会约束本轮实现、范围或验证的事实；至少需要一项。',
      '',
      '  delivery-analysis impact upsert --key <稳定key> --area <受影响范围> --finding <发现> --disposition <change|preserve|exclude|needs_decision> --evidence <证据> [--decision <decisionKey>]',
      '  delivery-analysis impact remove --key <key>',
      '',
      'disposition：',
      '  change          本轮必须改变。',
      '  preserve        本轮必须保持，不能被实现破坏。',
      '  exclude         明确不属于本轮；需要独立业务结果时留给后续交付。',
      '  needs_decision  处理方式取决于尚未关闭的关键决策，必须通过 --decision 关联现有 decision key。',
      '',
      'key 表示跨 attempt 的稳定语义身份；补充或修正同一影响时复用原 key。',
    ];
  }
  if (topic === 'decision') {
    return [
      '关键决策只记录会改变业务结果、公共契约、数据语义、兼容策略、重大工程后果或独立验证结果的选择。',
      '',
      '创建决策：',
      '  delivery-analysis decision upsert --key <稳定key> --type <business|technical> --title <标题> --question <需要决定的事情> --impact <不同选择的影响>',
      '',
      'Agent 自主关闭路径：',
      '  decision upsert → decision resolve',
      '  delivery-analysis decision resolve --key <key> [--option <选项id>] --authority <upstream|user|project_evidence|agent_authority> --decision <结论> --rationale <理由> --evidence <证据>',
      '  没有创建候选选项时可以省略 --option；如果已经创建候选选项，必须选择其中一项。',
      '',
      'authority：',
      '  upstream          上游已经形成明确承诺。',
      '  user              当前 decision key 已有用户明确回答。',
      '  project_evidence  项目中有足以唯一确定结论的可定位证据。',
      '  agent_authority   属于本角色可安全承担的专业决策。',
      '',
      '用户确认路径：',
      '  decision upsert → 至少两次 option-upsert → impact needs_decision → decision ask → request-clarification',
      '  delivery-analysis decision option-upsert --key <key> --id <选项id> --label <名称> --consequence <后果>',
      '  delivery-analysis decision option-remove --key <key> --id <选项id>',
      '  delivery-analysis decision ask --key <key> --option <推荐选项id> --reason <推荐理由>',
      '',
      '维护：',
      '  delivery-analysis decision reopen --key <key>',
      '  delivery-analysis decision remove --key <key>',
      '  已有用户回答的 key 不得删除、改名或重新打开；恢复轮必须在原 key 上以 user 权限关闭。',
    ];
  }
  if (topic === 'contract') {
    return [
      '交付契约是 Dev 与 Test 共同依赖的冻结上游事实，不是两个 Agent 之间的信息交接，也不保存 Do It Twice 的中间推演。',
      'Dev 根据契约实现，Test 根据同一契约独立建立 Oracle；两者都不能用对方的工作声明替代自己的专业证据。',
      '',
      '必填：',
      '  delivery-analysis summary set --text <影响与决策分析结论>',
      '  delivery-analysis contract set --text <冻结交付契约中的实现方向>',
      '',
      '可选保护约束：',
      '  delivery-analysis guardrail upsert --key <key> --content <必须保护的约束> --rationale <理由>',
      '  delivery-analysis guardrail remove --key <key>',
      '',
      '可选验证关注点：',
      '  delivery-analysis verification-focus upsert --key <key> --expected <重点验证结果> --oracle <判定方法>',
      '  delivery-analysis verification-focus remove --key <key>',
      '  unit-acceptance 是 Application 自动注入的交付单元验收 key，属于系统保留值，不能覆盖。',
    ];
  }
  if (topic === 'finish') {
    return [
      '校验不会推进流程；可以反复执行并根据错误继续修正草稿。',
      '',
      '  delivery-analysis validate',
      '',
      '完成路径：',
      `  ${terminalActions.find((action) => action.endsWith(' complete')) || 'delivery-analysis complete'}`,
      '  要求摘要、交付契约和至少一个实际影响完整；所有关键决策已关闭，不再存在 needs_decision 影响。',
      '',
      '等待用户路径：',
      `  ${terminalActions.find((action) => action.endsWith(' request-clarification')) || 'delivery-analysis request-clarification'}`,
      '  仅在确实存在尚未回答、超出 Agent 权限的关键决策时使用；Application 会从这些决策生成结构化问题。',
      '',
      '普通最终文本、Markdown 或手写 JSON 都不会结束 execution。',
    ];
  }
  if (topic) {
    throw new Error(`交付分析 help 不支持主题：${topic}。可用主题：context、impact、decision、contract、finish`);
  }
  return [
    '完成交付分析必须具备：分析摘要、冻结交付契约、至少一个实际影响，以及所有真实关键决策的最终状态。',
    'guardrail 和 verification-focus 是可选补充；不存在关键决策时不需要创建 decision。',
    '',
    '标准路径：',
    '  无关键决策：status → summary/contract/impact → validate → complete',
    '  Agent 自主决策：decision upsert → decision resolve → validate → complete',
    '  用户决策：decision upsert → option-upsert（至少两个）→ impact needs_decision → decision ask → validate → request-clarification',
    '',
    '命令索引：',
    ...deliveryAnalysisCommandIndex,
    '',
    '终止命令：',
    ...terminalActions.map((action) => `  ${action}`),
    '',
    '主题帮助：',
    '  help context   只读上下文工具与使用时机',
    '  help impact    实际影响与 disposition 含义',
    '  help decision  自主决策、用户决策与 authority 含义',
    '  help contract  交付契约、保护约束与验证关注点',
    '  help finish    校验、完成与请求用户确认',
  ];
}

function upsert(
  db: Db,
  table: string,
  columns: string[],
  values: unknown[],
  keyColumn: string,
  updates: string[],
  draftId: string,
) {
  const ordinal = nextOrdinal(db, table, draftId);
  db.prepare(`
    INSERT INTO ${table}(draft_id, ${columns.join(', ')}, ordinal)
    VALUES(?, ${columns.map(() => '?').join(', ')}, ?)
    ON CONFLICT(draft_id, ${keyColumn}) DO UPDATE SET
      ${updates.map((column) => `${column} = excluded.${column}`).join(', ')}
  `).run(draftId, ...values, ordinal);
}

function remove(db: Db, table: string, keyColumn: string, draftId: string, key: string, label: string) {
  const result = db.prepare(`
    DELETE FROM ${table} WHERE draft_id = ? AND ${keyColumn} = ?
  `).run(draftId, key);
  if (!result.changes) throw new Error(`${label} ${key} 不存在`);
}

export function runDeliveryAnalysisCommand(input: {
  db: Db;
  execution: DeliveryAnalysisExecutionRow;
  draft: DeliveryAnalysisDraftRow;
  command: string;
  flags: FlagMap;
}) {
  const { db, execution, command, flags } = input;
  let { draft } = input;
  if (command === 'delivery-analysis status') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    draft = { ...draft, status_viewed_execution_id: execution.execution_id };
    return renderStatus(draft, state(db, draft));
  }
  const action = command === 'delivery-analysis complete'
    ? 'complete'
    : command === 'delivery-analysis request-clarification'
      ? 'request-clarification'
      : null;
  if (action && draft.terminal_execution_id === execution.execution_id && draft.terminal_action === action) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);

  if (command === 'delivery-analysis summary set' || command === 'delivery-analysis contract set') {
    const column = command.includes('summary') ? 'summary' : 'implementation_guidance';
    db.prepare(`UPDATE delivery_analysis_drafts SET ${column} = ? WHERE draft_id = ?`)
      .run(
        bounded(required(flags, 'text'), column === 'summary' ? '交付分析摘要' : '冻结交付契约中的实现方向', 10000),
        draft.draft_id,
      );
    touchDraft(db, draft.draft_id);
    return column === 'summary' ? '交付分析摘要已保存。' : '冻结交付契约已保存。';
  }

  if (command === 'delivery-analysis impact upsert') {
    const key = bounded(required(flags, 'key'), '影响 key', 120);
    const disposition = required(flags, 'disposition');
    if (!['change', 'preserve', 'exclude', 'needs_decision'].includes(disposition)) {
      throw new Error('影响 disposition 必须是 change、preserve、exclude 或 needs_decision');
    }
    const decisionKey = optional(flags, 'decision');
    if (disposition === 'needs_decision' && !decisionKey) {
      throw new Error('needs_decision 影响必须提供 --decision');
    }
    if (decisionKey && !db.prepare(`
      SELECT 1 FROM delivery_analysis_decisions
      WHERE draft_id = ? AND decision_key = ?
    `).get(draft.draft_id, decisionKey)) {
      throw new Error(`决策 ${decisionKey} 不存在`);
    }
    upsert(db, 'delivery_analysis_impacts',
      ['impact_key', 'area', 'finding', 'disposition', 'evidence', 'decision_key'],
      [
        key,
        bounded(required(flags, 'area'), '影响范围', 1000),
        bounded(required(flags, 'finding'), '影响发现'),
        disposition,
        bounded(required(flags, 'evidence'), '影响证据'),
        decisionKey,
      ],
      'impact_key', ['area', 'finding', 'disposition', 'evidence', 'decision_key'], draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `实际影响 ${key} 已保存。`;
  }
  if (command === 'delivery-analysis impact remove') {
    remove(db, 'delivery_analysis_impacts', 'impact_key', draft.draft_id, required(flags, 'key'), '实际影响');
    touchDraft(db, draft.draft_id);
    return '实际影响已移除。';
  }

  if (command === 'delivery-analysis decision upsert') {
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    const decisionType = required(flags, 'type');
    if (!['business', 'technical'].includes(decisionType)) {
      throw new Error('决策 type 必须是 business 或 technical');
    }
    upsert(db, 'delivery_analysis_decisions',
      ['decision_key', 'decision_type', 'title', 'question', 'impact', 'authority', 'status'],
      [
        key,
        decisionType,
        bounded(required(flags, 'title'), '决策标题', 500),
        bounded(required(flags, 'question'), '决策问题'),
        bounded(required(flags, 'impact'), '决策影响'),
        'needs_user_input',
        'needs_user_input',
      ],
      'decision_key', ['decision_type', 'title', 'question', 'impact'], draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `关键决策 ${key} 已保存。`;
  }
  if (command === 'delivery-analysis decision option-upsert') {
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    if (!db.prepare(`
      SELECT 1 FROM delivery_analysis_decisions WHERE draft_id = ? AND decision_key = ?
    `).get(draft.draft_id, key)) throw new Error(`决策 ${key} 不存在`);
    upsert(db, 'delivery_analysis_decision_options',
      ['decision_key', 'option_id', 'label', 'consequence'],
      [
        key,
        bounded(required(flags, 'id'), '选项 id', 100),
        bounded(required(flags, 'label'), '选项名称', 500),
        bounded(required(flags, 'consequence'), '选项后果'),
      ],
      'decision_key, option_id', ['label', 'consequence'], draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `决策 ${key} 的选项已保存。`;
  }
  if (command === 'delivery-analysis decision option-remove') {
    const result = db.prepare(`
      DELETE FROM delivery_analysis_decision_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).run(draft.draft_id, required(flags, 'key'), required(flags, 'id'));
    if (!result.changes) throw new Error('决策选项不存在');
    touchDraft(db, draft.draft_id);
    return '决策选项已移除。';
  }
  if (command === 'delivery-analysis decision resolve') {
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    const optionId = optional(flags, 'option');
    const authority = required(flags, 'authority') as DecisionAuthority;
    if (!['upstream', 'user', 'project_evidence', 'agent_authority'].includes(authority)) {
      throw new Error('决策 authority 必须是 upstream、user、project_evidence 或 agent_authority');
    }
    if (optionId && !db.prepare(`
      SELECT 1 FROM delivery_analysis_decision_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).get(draft.draft_id, key, optionId)) {
      throw new Error(`决策 ${key} 不存在选项 ${optionId}`);
    }
    const result = db.prepare(`
      UPDATE delivery_analysis_decisions
      SET authority = ?, status = 'resolved', selected_option_id = ?,
          decision_text = ?, rationale = ?, evidence = ?,
          recommendation_option_id = NULL, recommendation_reason = NULL
      WHERE draft_id = ? AND decision_key = ?
    `).run(
      authority,
      optionId,
      bounded(required(flags, 'decision'), '决策结论'),
      bounded(required(flags, 'rationale'), '决策理由'),
      bounded(required(flags, 'evidence'), '决策证据'),
      draft.draft_id,
      key,
    );
    if (!result.changes) throw new Error(`决策 ${key} 不存在`);
    touchDraft(db, draft.draft_id);
    return `决策 ${key} 已由 ${authority} 权限关闭。`;
  }
  if (command === 'delivery-analysis decision ask') {
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    const optionId = bounded(required(flags, 'option'), '推荐选项 id', 100);
    if (!db.prepare(`
      SELECT 1 FROM delivery_analysis_decision_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).get(draft.draft_id, key, optionId)) throw new Error(`决策 ${key} 不存在选项 ${optionId}`);
    db.prepare(`
      UPDATE delivery_analysis_decisions
      SET authority = 'needs_user_input', status = 'needs_user_input',
          selected_option_id = NULL, decision_text = NULL, rationale = NULL, evidence = NULL,
          recommendation_option_id = ?, recommendation_reason = ?
      WHERE draft_id = ? AND decision_key = ?
    `).run(optionId, bounded(required(flags, 'reason'), '推荐理由'), draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return `决策 ${key} 已标记为需要用户确认。`;
  }
  if (command === 'delivery-analysis decision reopen') {
    const key = required(flags, 'key');
    const answered = db.prepare(`
      SELECT 1 FROM questions
      WHERE task_id = ? AND story_index = ? AND source_agent = 'analyst-agent'
        AND decision_key = ? AND answer IS NOT NULL LIMIT 1
    `).get(draft.task_id, draft.story_index, key);
    if (answered) throw new Error(`决策 ${key} 已有用户回答，必须在原 key 上关闭`);
    const result = db.prepare(`
      UPDATE delivery_analysis_decisions
      SET authority = 'needs_user_input', status = 'needs_user_input',
          selected_option_id = NULL, decision_text = NULL, rationale = NULL, evidence = NULL
      WHERE draft_id = ? AND decision_key = ?
    `).run(draft.draft_id, key);
    if (!result.changes) throw new Error(`决策 ${key} 不存在`);
    touchDraft(db, draft.draft_id);
    return '决策已重新打开。';
  }
  if (command === 'delivery-analysis decision remove') {
    const key = required(flags, 'key');
    const answered = db.prepare(`
      SELECT 1 FROM questions
      WHERE task_id = ? AND story_index = ? AND source_agent = 'analyst-agent'
        AND decision_key = ? AND answer IS NOT NULL LIMIT 1
    `).get(draft.task_id, draft.story_index, key);
    if (answered) throw new Error(`决策 ${key} 已有用户回答，不能删除或改名`);
    remove(db, 'delivery_analysis_decisions', 'decision_key', draft.draft_id, key, '决策');
    touchDraft(db, draft.draft_id);
    return '决策已移除。';
  }

  if (command === 'delivery-analysis guardrail upsert') {
    const key = bounded(required(flags, 'key'), '保护约束 key', 120);
    upsert(db, 'delivery_analysis_guardrails',
      ['guardrail_key', 'content', 'rationale'],
      [
        key,
        bounded(required(flags, 'content'), '保护约束'),
        bounded(required(flags, 'rationale'), '保护理由'),
      ],
      'guardrail_key', ['content', 'rationale'], draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `保护约束 ${key} 已保存。`;
  }
  if (command === 'delivery-analysis guardrail remove') {
    remove(db, 'delivery_analysis_guardrails', 'guardrail_key', draft.draft_id, required(flags, 'key'), '保护约束');
    touchDraft(db, draft.draft_id);
    return '保护约束已移除。';
  }

  if (command === 'delivery-analysis verification-focus upsert') {
    const key = bounded(required(flags, 'key'), '验证关注点 key', 120);
    if (key === 'unit-acceptance') throw new Error('unit-acceptance 是系统保留的交付单元验收 key');
    upsert(db, 'delivery_analysis_verification_focus',
      ['focus_key', 'expected', 'oracle'],
      [
        key,
        bounded(required(flags, 'expected'), '重点验证结果'),
        bounded(required(flags, 'oracle'), '判定方法'),
      ],
      'focus_key', ['expected', 'oracle'], draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `验证关注点 ${key} 已保存。`;
  }
  if (command === 'delivery-analysis verification-focus remove') {
    remove(db, 'delivery_analysis_verification_focus', 'focus_key', draft.draft_id, required(flags, 'key'), '验证关注点');
    touchDraft(db, draft.draft_id);
    return '验证关注点已移除。';
  }

  if (command === 'delivery-analysis validate') {
    const errors = deliveryAnalysisValidationErrors(state(db, draft));
    if (errors.length) {
      throw new Error(`交付分析草稿校验失败：\n${errors.map((error, index) => `${index + 1}. ${error}`).join('\n')}`);
    }
    return '交付分析草稿结构校验通过。';
  }
  if (action) return submit(db, draft, execution, action);
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}

export const deliveryAnalysisCommandDraftInternals = {
  state,
  buildSpec,
  renderArtifact,
  buildResult,
};
