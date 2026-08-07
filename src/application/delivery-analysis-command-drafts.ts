import { agentResultSchema, type DeliverySpec } from '../domain/agent-result';
import {
  DELIVERY_ANALYSIS_PHASE_ORDER,
  DELIVERY_ANALYSIS_PHASE_SEQUENCE,
  DELIVERY_ANALYSIS_WORKFLOW,
  deliveryAnalysisNormalCommandPath,
  type DeliveryAnalysisPhase,
} from '../domain/delivery-analysis-workflow';
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

type DecisionProjectionStatus = 'active' | 'conditional' | 'not_applicable';

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
           acceptance, summary, implementation_guidance, workflow_phase,
           validated_change_seq
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
    workflow_phase: DeliveryAnalysisPhase;
    validated_change_seq: number | null;
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
  const decisionDependencies = db.prepare(`
    SELECT decision_key, parent_decision_key, parent_option_id
    FROM delivery_analysis_decision_dependencies
    WHERE draft_id = ?
    ORDER BY decision_key, parent_decision_key, parent_option_id
  `).all(draft.draft_id) as {
    decision_key: string;
    parent_decision_key: string;
    parent_option_id: string;
  }[];
  const answers = db.prepare(`
    SELECT decision_key, answer, selected_option_id, status
    FROM questions
    WHERE task_id = ? AND story_index = ? AND source_agent = 'analyst-agent'
      AND decision_key IS NOT NULL
      AND status != 'superseded'
    ORDER BY created_at, question_id
  `).all(draft.task_id, draft.story_index) as {
    decision_key: string;
    answer: string | null;
    selected_option_id: string | null;
    status: string;
  }[];
  const answerMap = new Map(answers.map((answer) => [answer.decision_key, answer]));
  const decisions = decisionRows.map((decision) => ({
    ...decision,
    options: decisionOptions.filter((option) => option.decision_key === decision.decision_key),
    dependencies: decisionDependencies.filter((dependency) =>
      dependency.decision_key === decision.decision_key),
    answer: answerMap.get(decision.decision_key)?.answer || null,
    answered_option_id: answerMap.get(decision.decision_key)?.selected_option_id || null,
    projection_status: 'active' as DecisionProjectionStatus,
  }));
  const decisionByKey = new Map(decisions.map((decision) => [decision.decision_key, decision]));
  for (let pass = 0; pass < decisions.length + 1; pass += 1) {
    let changed = false;
    for (const decision of decisions) {
      let next: DecisionProjectionStatus = 'active';
      if (decision.dependencies.length) {
        const parents = decision.dependencies.map((dependency) => ({
          dependency,
          parent: decisionByKey.get(dependency.parent_decision_key),
        }));
        const inactive = parents.find(({ parent }) => !parent || parent.projection_status === 'not_applicable');
        const mismatch = parents.find(({ dependency, parent }) => {
          const selected = parent?.status === 'resolved'
            ? parent.selected_option_id
            : parent?.answered_option_id;
          return Boolean(selected && selected !== dependency.parent_option_id);
        });
        const unresolved = parents.find(({ parent }) => {
          const selected = parent?.status === 'resolved'
            ? parent.selected_option_id
            : parent?.answered_option_id;
          return !selected;
        });
        next = inactive || mismatch ? 'not_applicable' : unresolved ? 'conditional' : 'active';
      }
      if (next !== decision.projection_status) {
        decision.projection_status = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const impacts = impactRows.map((impact) => ({
    ...impact,
    projection_status: impact.decision_key
      && decisionByKey.get(impact.decision_key)?.projection_status === 'not_applicable'
      ? 'not_applicable' as const
      : 'active' as const,
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
    impacts,
    decisions,
    guardrails,
    verificationFocus,
    answeredKeys: answers.filter((answer) => answer.answer).map((answer) => answer.decision_key),
  };
}

export type DeliveryAnalysisState = ReturnType<typeof state>;

function activeDecisions(current: DeliveryAnalysisState) {
  return current.decisions.filter((decision) => decision.projection_status !== 'not_applicable');
}

function activeImpacts(current: DeliveryAnalysisState) {
  return current.impacts.filter((impact) => impact.projection_status !== 'not_applicable');
}

function impactScanErrors(current: DeliveryAnalysisState) {
  const errors: string[] = [];
  if (!current.impacts.length) errors.push('至少需要记录一个经过调查的实际影响');

  const decisionKeys = new Set(current.decisions.map((decision) => decision.decision_key));
  for (const impact of current.impacts) {
    if (impact.decision_key && !decisionKeys.has(impact.decision_key)) {
      errors.push(`影响 ${impact.impact_key} 关联了不存在的决策 ${impact.decision_key}`);
    }
    if (impact.disposition === 'needs_decision') {
      if (!impact.decision_key) {
        errors.push(`待决策影响 ${impact.impact_key} 必须关联 decision key`);
      }
    }
  }
  return [...new Set(errors)];
}

function decisionDependencyErrors(current: DeliveryAnalysisState) {
  const errors: string[] = [];
  const byKey = new Map(current.decisions.map((decision) => [decision.decision_key, decision]));
  for (const decision of current.decisions) {
    for (const dependency of decision.dependencies) {
      if (dependency.parent_decision_key === decision.decision_key) {
        errors.push(`决策 ${decision.decision_key} 不能依赖自身`);
        continue;
      }
      const parent = byKey.get(dependency.parent_decision_key);
      if (!parent) {
        errors.push(`决策 ${decision.decision_key} 依赖了不存在的决策 ${dependency.parent_decision_key}`);
      } else if (!parent.options.some((option) => option.option_id === dependency.parent_option_id)) {
        errors.push(`决策 ${decision.decision_key} 的激活选项 ${dependency.parent_decision_key}=${dependency.parent_option_id} 不存在`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    const decision = byKey.get(key);
    const cyclic = Boolean(decision?.dependencies.some((dependency) => visit(dependency.parent_decision_key)));
    visiting.delete(key);
    visited.add(key);
    return cyclic;
  };
  if (current.decisions.some((decision) => visit(decision.decision_key))) {
    errors.push('决策树不能存在循环依赖');
  }
  return errors;
}

function decisionTreeStructuralErrors(current: DeliveryAnalysisState) {
  const errors = [...impactScanErrors(current), ...decisionDependencyErrors(current)];
  const decisions = activeDecisions(current);
  const impacts = activeImpacts(current);
  const decisionKeys = new Set(current.decisions.map((decision) => decision.decision_key));

  for (const decision of decisions) {
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
      if (!impacts.some((impact) =>
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
    const decision = decisions.find((item) => item.decision_key === key);
    if (decision && (decision.status !== 'resolved' || decision.authority !== 'user')) {
      errors.push(`已回答决策 ${key} 必须在原 key 上以 user 权限关闭`);
    }
  }

  for (const impact of impacts.filter((item) => item.disposition === 'needs_decision')) {
    const decision = decisions.find((item) => item.decision_key === impact.decision_key);
    if (decision?.status === 'resolved') {
      errors.push(`决策 ${decision.decision_key} 已关闭，但影响 ${impact.impact_key} 仍为 needs_decision；使用 impact resolve`);
    }
  }
  return [...new Set(errors)];
}

function decisionTreeCompletionErrors(current: DeliveryAnalysisState) {
  const errors = [...decisionTreeStructuralErrors(current)];
  const unresolved = activeDecisions(current).filter((decision) => decision.status === 'needs_user_input');
  if (unresolved.length) errors.push(`仍有 ${unresolved.length} 个活动关键决策未关闭`);
  if (activeImpacts(current).some((impact) => impact.disposition === 'needs_decision')) {
    errors.push('仍有尚未确定最终处理方式的活动影响');
  }
  return [...new Set(errors)];
}

function deliveryContractErrors(current: DeliveryAnalysisState) {
  const errors = [...decisionTreeCompletionErrors(current)];
  if (!current.contract.summary?.trim()) errors.push('缺少交付分析摘要');
  if (!current.contract.implementation_guidance?.trim()) errors.push('缺少冻结交付契约中的实现方向');
  return [...new Set(errors)];
}

export function deliveryAnalysisValidationErrors(current: DeliveryAnalysisState) {
  return deliveryContractErrors(current);
}

type DeliveryAnalysisReadiness = {
  status: 'not_ready' | 'decisions_required' | 'structurally_ready';
  remaining: string[];
  nextCommand: string | null;
};

function deliveryAnalysisReadiness(
  current: DeliveryAnalysisState,
  phase: DeliveryAnalysisPhase,
): DeliveryAnalysisReadiness {
  if (phase === 'decision_tree') {
    const remaining = decisionTreeStructuralErrors(current);
    if (remaining.length) return { status: 'not_ready', remaining, nextCommand: null };
    const pending = activeDecisions(current).filter((decision) =>
      decision.status === 'needs_user_input' && !decision.answer);
    if (pending.length) {
      return { status: 'decisions_required', remaining: [], nextCommand: 'delivery-analysis validate' };
    }
    const completion = decisionTreeCompletionErrors(current);
    if (completion.length) return { status: 'not_ready', remaining: completion, nextCommand: null };
    return {
      status: 'structurally_ready',
      remaining: [],
      nextCommand: DELIVERY_ANALYSIS_WORKFLOW.decision_tree.submit,
    };
  }
  const remaining = phase === 'impact_scan'
    ? impactScanErrors(current)
    : phase === 'delivery_contract'
      ? deliveryContractErrors(current)
      : deliveryAnalysisValidationErrors(current);
  if (remaining.length) return { status: 'not_ready', remaining, nextCommand: null };
  return {
    status: 'structurally_ready',
    remaining: [],
    nextCommand: phase === 'finalize'
      ? 'delivery-analysis validate'
      : DELIVERY_ANALYSIS_WORKFLOW[phase].submit,
  };
}

function renderReadiness(current: DeliveryAnalysisState, phase: DeliveryAnalysisPhase) {
  const readiness = deliveryAnalysisReadiness(current, phase);
  const definition = DELIVERY_ANALYSIS_WORKFLOW[phase];
  const lines = ['## READINESS', '', `- Status: ${readiness.status}`];
  if (readiness.status === 'not_ready') {
    lines.push(
      '',
      '## REMAINING REQUIREMENTS',
      '',
      ...readiness.remaining.map((item, index) => `${index + 1}. ${item}`),
      '',
      '继续当前工作包；补齐以上缺口后再查看 `delivery-analysis status`。',
    );
    return lines;
  }
  lines.push(
    '',
    '## REVIEW BEFORE SUBMIT',
    '',
    ...definition.reviewBeforeSubmit.map((item) => `- ${item}`),
    '',
    readiness.status === 'decisions_required' || phase === 'finalize' ? '## VALIDATE' : '## SUBMIT',
    '',
    `\`${readiness.nextCommand}\``,
  );
  return lines;
}

function renderWorkPacket(current: DeliveryAnalysisState, phase: DeliveryAnalysisPhase) {
  const definition = DELIVERY_ANALYSIS_WORKFLOW[phase];
  return [
    '# NEXT WORK PACKET',
    '',
    '## PHASE',
    '',
    `${definition.title} · ${phase}`,
    '',
    '## OBJECTIVE',
    '',
    definition.objective,
    '',
    '## REQUIRED',
    '',
    definition.required,
    '',
    '## DO NOT',
    '',
    definition.prohibited,
    '',
    '## AVAILABLE COMMANDS',
    '',
    ...definition.commands.map((command) => `- \`${command}\``),
    '',
    ...renderReadiness(current, phase),
  ].join('\n');
}

type DeliveryAnalysisOutcome =
  | 'state_restored'
  | 'accepted'
  | 'phase_completed'
  | 'validation_passed'
  | 'waiting_for_human'
  | 'completed'
  | 'already_submitted';

function renderCommandResult(input: {
  command: string;
  outcome: DeliveryAnalysisOutcome;
  details?: string[];
}) {
  return [
    '# COMMAND RESULT',
    '',
    `- Command: \`${input.command}\``,
    `- Outcome: ${input.outcome}`,
    ...(input.details || []).map((detail) => `- ${detail}`),
  ].join('\n');
}

function renderContinue(command: string, changed: string, current: DeliveryAnalysisState) {
  const phase = current.contract.workflow_phase;
  const readiness = deliveryAnalysisReadiness(current, phase);
  const definition = DELIVERY_ANALYSIS_WORKFLOW[phase];
  const next = ['# NEXT', '', `- Phase: ${phase}`, `- Readiness: ${readiness.status}`];
  if (readiness.status === 'not_ready') {
    next.push(
      '- Action: continue_current_work_packet',
      '- Remaining:',
      ...readiness.remaining.map((item) => `  - ${item}`),
      '- Refresh: `delivery-analysis status`',
    );
  } else {
    next.push(
      '- Action: review_before_submit',
      '- Review:',
      ...definition.reviewBeforeSubmit.map((item) => `  - ${item}`),
      `- ${readiness.status === 'decisions_required' || phase === 'finalize' ? 'Validate' : 'Submit'}: \`${readiness.nextCommand}\``,
    );
  }
  return [
    renderCommandResult({ command, outcome: 'accepted', details: [`Changed: ${changed}`] }),
    '',
    ...next,
  ].join('\n');
}

function renderStatus(draft: DeliveryAnalysisDraftRow, current: DeliveryAnalysisState) {
  const decisions = activeDecisions(current);
  const impacts = activeImpacts(current);
  const lines = [
    renderCommandResult({
      command: 'delivery-analysis status',
      outcome: 'state_restored',
      details: [`Phase: ${current.contract.workflow_phase}`],
    }),
    '',
    renderWorkPacket(current, current.contract.workflow_phase),
    '',
    '# CURRENT DRAFT',
    '',
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
    `实际影响：${impacts.length}（待决策 ${impacts.filter((item) => item.disposition === 'needs_decision').length}）`,
    `关键决策：${decisions.length}（已关闭 ${decisions.filter((item) => item.status === 'resolved').length} / 待确认 ${decisions.filter((item) => item.status === 'needs_user_input').length}）`,
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
  if (impacts.length) {
    lines.push('', '影响索引：');
    for (const impact of impacts) {
      lines.push(`- ${impact.impact_key} · ${impact.disposition} · ${impact.area}${impact.decision_key ? ` · decision=${impact.decision_key}` : ''}`);
    }
  }
  if (decisions.length) {
    lines.push('', '决策索引（decision key 跨轮次不可改名）：');
    for (const decision of decisions) {
      lines.push(`- ${decision.decision_key} · ${decision.decision_type} · ${decision.projection_status} · ${decision.status} · ${decision.authority}${decision.answer ? ` · 已回答=${decision.answer}` : ''}`);
    }
  }
  const pruned = current.decisions.length - decisions.length;
  if (pruned) lines.push('', `未命中的决策分支：${pruned} 个（仅保留审计历史，不进入当前判断）`);
  return lines.join('\n');
}

function buildSpec(current: DeliveryAnalysisState): DeliverySpec {
  const impacts = activeImpacts(current);
  const decisions = activeDecisions(current);
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
    impacts: impacts.map((impact) => ({
      key: impact.impact_key,
      area: impact.area,
      finding: impact.finding,
      disposition: impact.disposition,
      evidence: impact.evidence,
      ...(impact.decision_key ? { decisionKey: impact.decision_key } : {}),
    })),
    decisions: decisions.map((decision) => ({
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
  const impacts = activeImpacts(current);
  const decisions = activeDecisions(current);
  const lines = [
    '# 交付分析',
    '',
    `> ${current.contract.title}`,
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
    ...impacts.map((impact) =>
      `- **${impact.disposition} · ${impact.area}**：${impact.finding}\n  - 证据：${impact.evidence}`),
    '',
    '## 关键决策',
    '',
    ...(decisions.length
      ? decisions.map((decision) =>
          `- **${decision.decision_type} · ${decision.title}**：${decision.decision_text || '等待用户确认'}\n  - 权限：${decision.authority}\n  - 影响：${decision.impact}\n  - 依据：${decision.evidence || decision.recommendation_reason || ''}`)
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
      `- ${guardrail.content}\n  - 理由：${guardrail.rationale}`));
  }
  lines.push(
    '',
    '### 验证关注点',
    '',
    `- ${current.contract.acceptance}\n  - Oracle：${current.contract.observable_outcome}`,
    ...current.verificationFocus.map((focus) =>
      `- ${focus.expected}\n  - Oracle：${focus.oracle}`),
  );
  return lines.join('\n');
}

function renderDecisionDraftArtifact(current: DeliveryAnalysisState) {
  const decisions = activeDecisions(current);
  const impacts = activeImpacts(current);
  return [
    '# 交付分析决策草稿',
    '',
    `## ${current.contract.title}`,
    '',
    '### 已识别影响',
    '',
    ...impacts.map((impact) =>
      `- ${impact.area}：${impact.finding}（${impact.disposition}）`),
    '',
    '### 当前活动决策',
    '',
    ...decisions.map((decision) =>
      `- ${decision.title}：${decision.status === 'resolved' ? decision.decision_text : '等待确认'}`),
  ].join('\n');
}

function buildResult(current: DeliveryAnalysisState, action: 'complete' | 'request-clarification') {
  const decisions = activeDecisions(current);
  const questions = decisions
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
        dependsOn: decision.dependencies.map((dependency) => dependency.parent_decision_key),
        activation: decision.dependencies.map((dependency) => ({
          decisionKey: dependency.parent_decision_key,
          optionId: dependency.parent_option_id,
        })),
        initialStatus: decision.projection_status === 'active'
          ? 'pending' as const
          : decision.projection_status === 'conditional'
            ? 'conditional' as const
            : 'not_applicable' as const,
      };
    });
  if (action === 'request-clarification') {
    return agentResultSchema.parse({
      outcome: 'needs_input',
      summary: `交付分析仍有 ${questions.length} 个超出 Agent 权限的关键决策需要用户确认`,
      artifact: {
        title: '交付分析决策草稿',
        content: renderDecisionDraftArtifact(current),
      },
      questions,
    });
  }
  return agentResultSchema.parse({
    outcome: 'completed',
    summary: '当前交付单元的真实影响、关键决策和冻结交付契约已经收敛',
    artifact: { title: '交付分析', content: renderArtifact(current) },
    spec: buildSpec(current),
    questions: [],
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
  const expectedPhase: DeliveryAnalysisPhase = action === 'complete' ? 'finalize' : 'decision_tree';
  if (current.contract.workflow_phase !== expectedPhase) {
    throw new Error(`${action} 只能在 ${expectedPhase} 阶段执行；当前阶段是 ${current.contract.workflow_phase}`);
  }
  if (current.contract.validated_change_seq !== draft.change_seq) {
    throw new Error('当前草稿版本尚未通过 validate，或验证后又发生了编辑');
  }
  const errors = action === 'complete'
    ? deliveryAnalysisValidationErrors(current)
    : decisionTreeStructuralErrors(current);
  if (action === 'request-clarification') {
    const pending = activeDecisions(current).filter((decision) =>
      decision.status === 'needs_user_input' && !decision.answer);
    if (!pending.length) errors.push('没有待用户回答的活动关键决策');
  }
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
  return [
    renderCommandResult({
      command: `delivery-analysis ${action}`,
      outcome: action === 'complete' ? 'completed' : 'waiting_for_human',
    }),
    '',
    '# NEXT',
    '',
    '- Owner: Application',
    `- Agent Action: ${action === 'complete' ? 'end_execution' : 'wait_for_human'}`,
  ].join('\n');
}

function transitionPhase(input: {
  db: Db;
  draft: DeliveryAnalysisDraftRow;
  execution: DeliveryAnalysisExecutionRow;
  current: DeliveryAnalysisState;
  from: DeliveryAnalysisPhase;
  to: DeliveryAnalysisPhase;
  reason: string;
}) {
  const { db, draft, execution, current, from, to, reason } = input;
  if (current.contract.workflow_phase !== from) {
    throw new Error(`当前阶段是 ${current.contract.workflow_phase}，不能提交 ${from}`);
  }
  const errors = from === 'impact_scan'
    ? impactScanErrors(current)
    : from === 'decision_tree'
      ? decisionTreeCompletionErrors(current)
      : deliveryContractErrors(current);
  if (errors.length) {
    throw new Error(`${from} 阶段不能完成：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE delivery_analysis_drafts
      SET workflow_phase = ?, validated_change_seq = NULL
      WHERE draft_id = ?
    `).run(to, draft.draft_id);
    db.prepare(`
      INSERT INTO delivery_analysis_phase_transitions(
        draft_id, from_phase, to_phase, reason, execution_id
      ) VALUES(?, ?, ?, ?, ?)
    `).run(draft.draft_id, from, to, reason, execution.execution_id);
    touchDraft(db, draft.draft_id);
  })();
  const next = state(db, draft);
  return [
    renderCommandResult({
      command: DELIVERY_ANALYSIS_WORKFLOW[from].submit,
      outcome: 'phase_completed',
      details: [`From: ${from}`, `To: ${to}`],
    }),
    '',
    renderWorkPacket(next, to),
  ].join('\n');
}

function reopenPhase(input: {
  db: Db;
  draft: DeliveryAnalysisDraftRow;
  execution: DeliveryAnalysisExecutionRow;
  command: string;
  from: DeliveryAnalysisPhase;
  to: DeliveryAnalysisPhase;
  reason: string;
}) {
  const { db, draft, execution, command, from, to, reason } = input;
  const current = state(db, draft);
  if (current.contract.workflow_phase !== from) {
    throw new Error(`只有 ${from} 阶段可以执行该回流；当前阶段是 ${current.contract.workflow_phase}`);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE delivery_analysis_drafts
      SET workflow_phase = ?, validated_change_seq = NULL
      WHERE draft_id = ?
    `).run(to, draft.draft_id);
    db.prepare(`
      INSERT INTO delivery_analysis_phase_transitions(
        draft_id, from_phase, to_phase, reason, execution_id
      ) VALUES(?, ?, ?, ?, ?)
    `).run(draft.draft_id, from, to, reason, execution.execution_id);
    touchDraft(db, draft.draft_id);
  })();
  const next = state(db, draft);
  return [
    renderCommandResult({
      command,
      outcome: 'phase_completed',
      details: [`From: ${from}`, `To: ${to}`, `Reason: ${reason}`],
    }),
    '',
    renderWorkPacket(next, to),
  ].join('\n');
}

const deliveryAnalysisCommandIndex = [
  '  delivery-analysis impact-scan complete',
  '  delivery-analysis decision-tree complete',
  '  delivery-analysis contract complete',
  '  delivery-analysis decision-tree reopen-impacts --reason <原因>',
  '  delivery-analysis contract reopen-decisions --reason <原因>',
  '  delivery-analysis contract reopen-impacts --reason <原因>',
  '  delivery-analysis finalize reopen-contract --reason <原因>',
  '  delivery-analysis summary set --text <影响与决策分析结论>',
  '  delivery-analysis contract set --text <冻结交付契约中的实现方向>',
  '  delivery-analysis impact upsert --key <key> --area <受影响范围> --finding <发现> --disposition <change|preserve|exclude|needs_decision> --evidence <证据> [--decision <decisionKey>]',
  '  delivery-analysis impact remove --key <key>',
  '  delivery-analysis impact resolve --key <key> --disposition <change|preserve|exclude> --evidence <证据> [--finding <最终发现>]',
  '  delivery-analysis decision upsert --key <key> --type <business|technical> --title <标题> --question <决策问题> --impact <不同选择的影响>',
  '  delivery-analysis decision option-upsert --key <key> --id <选项id> --label <名称> --consequence <后果>',
  '  delivery-analysis decision option-remove --key <key> --id <选项id>',
  '  delivery-analysis decision depends-on --key <key> --parent <decisionKey> --option <optionId>',
  '  delivery-analysis decision dependency-remove --key <key> --parent <decisionKey> --option <optionId>',
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
      '  delivery-analysis impact resolve --key <key> --disposition <change|preserve|exclude> --evidence <证据> [--finding <最终发现>]',
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
      '  decision upsert → 至少两次 option-upsert → impact needs_decision → decision ask → validate → request-clarification',
      '  delivery-analysis decision option-upsert --key <key> --id <选项id> --label <名称> --consequence <后果>',
      '  delivery-analysis decision option-remove --key <key> --id <选项id>',
      '  delivery-analysis decision depends-on --key <key> --parent <decisionKey> --option <optionId>',
      '  delivery-analysis decision dependency-remove --key <key> --parent <decisionKey> --option <optionId>',
      '  delivery-analysis decision ask --key <key> --option <推荐选项id> --reason <推荐理由>',
      '  决策关闭后，使用 impact resolve 将关联影响更新为最终 disposition。',
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
    const normalPath = deliveryAnalysisNormalCommandPath();
    return [
      '交付分析采用四段调用链；每个阶段完成命令都会校验当前产物、记录转换并返回下一工作包。',
      '',
      '阶段路径：',
      `  ${DELIVERY_ANALYSIS_PHASE_SEQUENCE}`,
      `  status → ${normalPath.map((command) => command.replace(/^delivery-analysis /, '')).join(' → ')}`,
      '',
      '人工决策路径：',
      '  DECISION TREE structurally complete → delivery-analysis validate',
      `  ${terminalActions.find((action) => action.endsWith(' request-clarification')) || 'delivery-analysis request-clarification'}`,
      '  恢复后仍处于 DECISION TREE，必须在原 decision key 上消费答案。',
      '',
      '最终校验与提交：',
      '  delivery-analysis validate',
      `  ${terminalActions.find((action) => action.endsWith(' complete')) || 'delivery-analysis complete'}`,
      '  validate 绑定当前草稿变更版本；验证后任何编辑都会使它失效。',
      '',
      '普通最终文本、Markdown 或手写 JSON 都不会结束 execution。',
    ];
  }
  if (topic) {
    throw new Error(`交付分析 help 不支持主题：${topic}。可用主题：context、impact、decision、contract、finish`);
  }
  return [
    `阶段路径：${DELIVERY_ANALYSIS_PHASE_SEQUENCE}`,
    '当前阶段的命令、readiness 和下一步以 delivery-analysis status 返回的工作包为准。',
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
    return [
      renderCommandResult({ command, outcome: 'already_submitted' }),
      '',
      '# NEXT',
      '',
      '- Owner: Application',
      '- Agent Action: end_execution',
    ].join('\n');
  }
  assertViewed(draft, execution.execution_id);
  const current = () => state(db, draft);
  const accepted = (changed: string) => renderContinue(command, changed, current());
  const assertPhase = (...allowed: DeliveryAnalysisPhase[]) => {
    const phase = current().contract.workflow_phase;
    if (!allowed.includes(phase)) {
      throw new Error(`命令 ${command} 不属于当前 ${phase} 工作包；允许阶段：${allowed.join('、')}`);
    }
  };

  const phaseCompletion = new Map<string, DeliveryAnalysisPhase>(
    DELIVERY_ANALYSIS_PHASE_ORDER
      .filter((phase) => phase !== 'finalize')
      .map((phase) => [DELIVERY_ANALYSIS_WORKFLOW[phase].submit, phase]),
  );
  const completedPhase = phaseCompletion.get(command);
  if (completedPhase) {
    const phaseIndex = DELIVERY_ANALYSIS_PHASE_ORDER.indexOf(completedPhase);
    const next = DELIVERY_ANALYSIS_PHASE_ORDER[phaseIndex + 1];
    if (!next) throw new Error(`${completedPhase} 没有可用的下一阶段`);
    return transitionPhase({
      db,
      draft,
      execution,
      current: current(),
      from: completedPhase,
      to: next,
      reason: `${completedPhase} 阶段产物校验通过`,
    });
  }

  const reopenCommands = new Map<string, [DeliveryAnalysisPhase, DeliveryAnalysisPhase]>([
    ['delivery-analysis decision-tree reopen-impacts', ['decision_tree', 'impact_scan']],
    ['delivery-analysis contract reopen-decisions', ['delivery_contract', 'decision_tree']],
    ['delivery-analysis contract reopen-impacts', ['delivery_contract', 'impact_scan']],
    ['delivery-analysis finalize reopen-contract', ['finalize', 'delivery_contract']],
  ]);
  const reopen = reopenCommands.get(command);
  if (reopen) {
    return reopenPhase({
      db,
      draft,
      execution,
      command,
      from: reopen[0],
      to: reopen[1],
      reason: bounded(required(flags, 'reason'), '阶段回流原因'),
    });
  }

  if (command === 'delivery-analysis summary set' || command === 'delivery-analysis contract set') {
    assertPhase('delivery_contract');
    const column = command.includes('summary') ? 'summary' : 'implementation_guidance';
    db.prepare(`UPDATE delivery_analysis_drafts SET ${column} = ? WHERE draft_id = ?`)
      .run(
        bounded(required(flags, 'text'), column === 'summary' ? '交付分析摘要' : '冻结交付契约中的实现方向', 10000),
        draft.draft_id,
      );
    touchDraft(db, draft.draft_id);
    return accepted(column === 'summary' ? 'analysis summary' : 'delivery contract');
  }

  if (command === 'delivery-analysis impact upsert') {
    assertPhase('impact_scan');
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
    return accepted(`impact/${key} upserted`);
  }
  if (command === 'delivery-analysis impact remove') {
    assertPhase('impact_scan');
    remove(db, 'delivery_analysis_impacts', 'impact_key', draft.draft_id, required(flags, 'key'), '实际影响');
    touchDraft(db, draft.draft_id);
    return accepted(`impact/${required(flags, 'key')} removed`);
  }
  if (command === 'delivery-analysis impact resolve') {
    assertPhase('decision_tree');
    const key = bounded(required(flags, 'key'), '影响 key', 120);
    const disposition = required(flags, 'disposition');
    if (!['change', 'preserve', 'exclude'].includes(disposition)) {
      throw new Error('impact resolve 的 disposition 必须是 change、preserve 或 exclude');
    }
    const existing = db.prepare(`
      SELECT finding, disposition, decision_key
      FROM delivery_analysis_impacts
      WHERE draft_id = ? AND impact_key = ?
    `).get(draft.draft_id, key) as {
      finding: string;
      disposition: string;
      decision_key: string | null;
    } | undefined;
    if (!existing) throw new Error(`实际影响 ${key} 不存在`);
    if (existing.disposition !== 'needs_decision' || !existing.decision_key) {
      throw new Error(`影响 ${key} 不是待决策影响，不能使用 impact resolve`);
    }
    const decision = db.prepare(`
      SELECT status FROM delivery_analysis_decisions
      WHERE draft_id = ? AND decision_key = ?
    `).get(draft.draft_id, existing.decision_key) as { status: string } | undefined;
    if (decision?.status !== 'resolved') {
      throw new Error(`关联决策 ${existing.decision_key} 尚未关闭`);
    }
    db.prepare(`
      UPDATE delivery_analysis_impacts
      SET disposition = ?, finding = ?, evidence = ?
      WHERE draft_id = ? AND impact_key = ?
    `).run(
      disposition,
      optional(flags, 'finding')
        ? bounded(required(flags, 'finding'), '最终影响发现')
        : existing.finding,
      bounded(required(flags, 'evidence'), '最终影响证据'),
      draft.draft_id,
      key,
    );
    touchDraft(db, draft.draft_id);
    return accepted(`impact/${key} resolved_as ${disposition}`);
  }

  if (command === 'delivery-analysis decision upsert') {
    assertPhase('impact_scan', 'decision_tree');
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
    return accepted(`decision/${key} upserted`);
  }
  if (command === 'delivery-analysis decision option-upsert') {
    assertPhase('decision_tree');
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
    return accepted(`decision/${key} option/${required(flags, 'id')} upserted`);
  }
  if (command === 'delivery-analysis decision option-remove') {
    assertPhase('decision_tree');
    const result = db.prepare(`
      DELETE FROM delivery_analysis_decision_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).run(draft.draft_id, required(flags, 'key'), required(flags, 'id'));
    if (!result.changes) throw new Error('决策选项不存在');
    touchDraft(db, draft.draft_id);
    return accepted(`decision/${required(flags, 'key')} option/${required(flags, 'id')} removed`);
  }
  if (
    command === 'delivery-analysis decision depends-on'
    || command === 'delivery-analysis decision dependency-remove'
  ) {
    assertPhase('decision_tree');
    const key = bounded(required(flags, 'key'), 'decision key', 120);
    const parent = bounded(required(flags, 'parent'), '父 decision key', 120);
    const option = bounded(required(flags, 'option'), '父决策选项 id', 100);
    if (key === parent) throw new Error('决策不能依赖自身');
    if (!db.prepare(`
      SELECT 1 FROM delivery_analysis_decisions
      WHERE draft_id = ? AND decision_key = ?
    `).get(draft.draft_id, key)) throw new Error(`决策 ${key} 不存在`);
    if (!db.prepare(`
      SELECT 1 FROM delivery_analysis_decision_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).get(draft.draft_id, parent, option)) {
      throw new Error(`父决策选项 ${parent}=${option} 不存在`);
    }
    if (command.endsWith('depends-on')) {
      db.prepare(`
        INSERT INTO delivery_analysis_decision_dependencies(
          draft_id, decision_key, parent_decision_key, parent_option_id
        ) VALUES(?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(draft.draft_id, key, parent, option);
    } else {
      const removed = db.prepare(`
        DELETE FROM delivery_analysis_decision_dependencies
        WHERE draft_id = ? AND decision_key = ?
          AND parent_decision_key = ? AND parent_option_id = ?
      `).run(draft.draft_id, key, parent, option);
      if (!removed.changes) throw new Error(`决策 ${key} 不存在依赖 ${parent}=${option}`);
    }
    touchDraft(db, draft.draft_id);
    return accepted(`decision/${key} dependency/${parent}=${option} ${command.endsWith('depends-on') ? 'added' : 'removed'}`);
  }
  if (command === 'delivery-analysis decision resolve') {
    assertPhase('decision_tree');
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
    return accepted(`decision/${key} resolved_by ${authority}`);
  }
  if (command === 'delivery-analysis decision ask') {
    assertPhase('decision_tree');
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
    return accepted(`decision/${key} marked_for_human`);
  }
  if (command === 'delivery-analysis decision reopen') {
    assertPhase('decision_tree');
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
    return accepted(`decision/${key} reopened`);
  }
  if (command === 'delivery-analysis decision remove') {
    assertPhase('decision_tree');
    const key = required(flags, 'key');
    const answered = db.prepare(`
      SELECT 1 FROM questions
      WHERE task_id = ? AND story_index = ? AND source_agent = 'analyst-agent'
        AND decision_key = ? AND answer IS NOT NULL LIMIT 1
    `).get(draft.task_id, draft.story_index, key);
    if (answered) throw new Error(`决策 ${key} 已有用户回答，不能删除或改名`);
    remove(db, 'delivery_analysis_decisions', 'decision_key', draft.draft_id, key, '决策');
    touchDraft(db, draft.draft_id);
    return accepted(`decision/${key} removed`);
  }

  if (command === 'delivery-analysis guardrail upsert') {
    assertPhase('delivery_contract');
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
    return accepted(`guardrail/${key} upserted`);
  }
  if (command === 'delivery-analysis guardrail remove') {
    assertPhase('delivery_contract');
    remove(db, 'delivery_analysis_guardrails', 'guardrail_key', draft.draft_id, required(flags, 'key'), '保护约束');
    touchDraft(db, draft.draft_id);
    return accepted(`guardrail/${required(flags, 'key')} removed`);
  }

  if (command === 'delivery-analysis verification-focus upsert') {
    assertPhase('delivery_contract');
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
    return accepted(`verification-focus/${key} upserted`);
  }
  if (command === 'delivery-analysis verification-focus remove') {
    assertPhase('delivery_contract');
    remove(db, 'delivery_analysis_verification_focus', 'focus_key', draft.draft_id, required(flags, 'key'), '验证关注点');
    touchDraft(db, draft.draft_id);
    return accepted(`verification-focus/${required(flags, 'key')} removed`);
  }

  if (command === 'delivery-analysis validate') {
    const currentState = current();
    const phase = currentState.contract.workflow_phase;
    const readiness = deliveryAnalysisReadiness(currentState, phase);
    const clarification = phase === 'decision_tree' && readiness.status === 'decisions_required';
    if (phase !== 'finalize' && !clarification) {
      throw new Error(
        `当前 ${phase} 阶段不使用 validate；请先完成当前工作包。`
        + ' validate 仅用于完整 HUMAN 决策批次或 FINALIZE。',
      );
    }
    const errors = clarification
      ? decisionTreeStructuralErrors(currentState)
      : deliveryAnalysisValidationErrors(currentState);
    if (errors.length) {
      throw new Error(`交付分析草稿校验失败：\n${errors.map((error, index) => `${index + 1}. ${error}`).join('\n')}`);
    }
    db.prepare(`
      UPDATE delivery_analysis_drafts
      SET validated_change_seq = ?
      WHERE draft_id = ?
    `).run(draft.change_seq, draft.draft_id);
    const nextCommand = clarification
      ? 'delivery-analysis request-clarification'
      : 'delivery-analysis complete';
    return [
      renderCommandResult({
        command,
        outcome: 'validation_passed',
        details: [`Phase: ${phase}`, 'Readiness: validated'],
      }),
      '',
      '# NEXT',
      '',
      `- Phase: ${phase}`,
      '- Readiness: validated',
      `- Action: \`${nextCommand}\``,
    ].join('\n');
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
