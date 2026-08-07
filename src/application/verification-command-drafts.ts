import { createHash } from 'node:crypto';
import { agentResultSchema, deliverySpecSchema } from '../domain/agent-result';
import {
  VERIFICATION_PHASE_SEQUENCE,
  VERIFICATION_WORKFLOW,
  type VerificationPhase,
} from '../domain/verification-workflow';
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

type RequiredRef = {
  key: string;
  kind: 'acceptance' | 'focus' | 'guardrail' | 'recovery';
  description: string;
  oracle: string;
};

type Scenario = {
  scenario_key: string;
  channel: 'frontend' | 'api';
  title: string;
  setup: string;
  steps: string;
  expected: string;
  coverageRefs: string[];
  ordinal: number;
};

type ScenarioResult = {
  scenario_key: string;
  status: 'passed' | 'failed' | 'blocked';
  failure_kind: 'implementation' | 'specification' | 'environment' | 'inconclusive' | null;
  evidence: string;
  actual_behavior: string | null;
  ordinal: number;
};

type RuntimeInputSubmission = {
  key: string;
  title: string;
  question: string;
  why: string;
  recommendation: string;
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

function optionalBounded(flags: FlagMap, name: string, label: string, max = 4000) {
  const value = flags.get(name)?.trim();
  return value ? bounded(value, label, max) : null;
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

function invalidateValidation(db: Db, draftId: string) {
  db.prepare(`
    UPDATE verification_drafts SET validated_change_seq = NULL WHERE draft_id = ?
  `).run(draftId);
  touchDraft(db, draftId);
}

function assertViewed(draft: VerificationDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 verification status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function parseCoverageRefs(raw: string) {
  const refs = [...new Set(raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean))];
  if (!refs.length) throw new Error('--covers 至少需要一个覆盖引用');
  if (refs.length > 100) throw new Error('--covers 最多包含 100 个覆盖引用');
  for (const ref of refs) bounded(ref, '覆盖引用', 240);
  return refs;
}

function parseStoredCoverage(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return [];
    return parsed;
  } catch {
    return [];
  }
}

function state(db: Db, draft: VerificationDraftRow) {
  const header = db.prepare(`
    SELECT phase, workflow_phase, spec_revision, validated_change_seq,
           evidence_review_summary, residual_risk
    FROM verification_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    phase: 'planning' | 'executing';
    workflow_phase: VerificationPhase;
    spec_revision: number | null;
    validated_change_seq: number | null;
    evidence_review_summary: string | null;
    residual_risk: string | null;
  };
  const scenarios = (db.prepare(`
    SELECT scenario_key, channel, title, setup, steps, expected,
           coverage_refs_json, ordinal
    FROM verification_plan_scenarios
    WHERE draft_id = ?
    ORDER BY ordinal, scenario_key
  `).all(draft.draft_id) as {
    scenario_key: string;
    channel: 'frontend' | 'api';
    title: string;
    setup: string;
    steps: string;
    expected: string;
    coverage_refs_json: string;
    ordinal: number;
  }[]).map((item): Scenario => ({
    ...item,
    coverageRefs: parseStoredCoverage(item.coverage_refs_json),
  }));
  const results = db.prepare(`
    SELECT scenario_key, status, failure_kind, evidence, actual_behavior, ordinal
    FROM verification_results
    WHERE draft_id = ?
    ORDER BY ordinal, scenario_key
  `).all(draft.draft_id) as ScenarioResult[];
  const runtimeInputs = db.prepare(`
    SELECT request_key, title, question,
           COALESCE(why, '') AS why,
           COALESCE(recommendation, '') AS recommendation,
           answer, status
    FROM runtime_input_requests
    WHERE task_id = ? AND story_index IS ? AND source_agent = 'test-agent'
      AND request_key IS NOT NULL AND status != 'superseded'
    ORDER BY created_at, request_id
  `).all(draft.task_id, draft.story_index) as {
    request_key: string;
    title: string;
    question: string;
    why: string;
    recommendation: string;
    answer: string | null;
    status: string;
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
    SELECT revision, spec_json
    FROM story_specs
    WHERE task_id = ? AND story_index = ? AND status = 'resolved'
    ORDER BY revision DESC LIMIT 1
  `).get(draft.task_id, draft.story_index) as {
    revision: number;
    spec_json: string;
  } | undefined;
  const requiredRefs: RequiredRef[] = [];
  let currentSpecRevision: number | null = null;
  try {
    const spec = specRow ? deliverySpecSchema.parse(JSON.parse(specRow.spec_json)) : null;
    if (spec && specRow) {
      currentSpecRevision = specRow.revision;
      requiredRefs.push({
        key: 'unit-acceptance',
        kind: 'acceptance',
        description: spec.unit.acceptance,
        oracle: spec.unit.observableOutcome,
      });
      for (const focus of spec.handoff.verificationFocus) {
        requiredRefs.push({
          key: `focus:${focus.key}`,
          kind: 'focus',
          description: focus.expected,
          oracle: focus.oracle,
        });
      }
      for (const guardrail of spec.handoff.guardrails) {
        requiredRefs.push({
          key: `guardrail:${guardrail.key}`,
          kind: 'guardrail',
          description: guardrail.content,
          oracle: guardrail.rationale,
        });
      }
    }
  } catch {
    // saveDeliverySpec validates before persistence. Status will expose the
    // missing resolved contract instead of silently freezing an empty plan.
  }
  for (const recovery of activeRecoveries) {
    requiredRefs.push({
      key: `recovery:${recovery.recovery_id}`,
      kind: 'recovery',
      description: recovery.summary,
      oracle: '原始失败应不再复现，且不能使用开发自述作为验证依据',
    });
  }
  return {
    header,
    scenarios,
    results,
    runtimeInputs,
    activeRecoveries,
    requiredRefs,
    currentSpecRevision,
  };
}

type VerificationState = ReturnType<typeof state>;
type DerivedConclusion = {
  action: 'pass' | 'fail' | 'block';
  failureKind?: 'implementation' | 'specification' | 'environment' | 'inconclusive';
};

function coveredRefs(current: VerificationState) {
  return new Set(current.scenarios.flatMap((scenario) => scenario.coverageRefs));
}

function planErrors(current: VerificationState) {
  const errors: string[] = [];
  if (!current.currentSpecRevision || !current.requiredRefs.some((item) => item.key === 'unit-acceptance')) {
    errors.push('当前交付单元没有可读取的已收敛交付契约');
  }
  if (!current.scenarios.length) errors.push('测试计划至少需要一个场景');
  const covered = coveredRefs(current);
  const missing = current.requiredRefs.filter((item) => !covered.has(item.key));
  if (missing.length) {
    errors.push(`以下必测引用尚未被场景覆盖：${missing.map((item) => item.key).join(', ')}`);
  }
  if (!current.scenarios.some((scenario) =>
    scenario.channel === 'frontend' && scenario.coverageRefs.includes('unit-acceptance'))) {
    errors.push('unit-acceptance 必须由至少一个 frontend 场景覆盖');
  }
  return errors;
}

function executionErrors(current: VerificationState) {
  const errors = planErrors(current);
  if (current.header.workflow_phase === 'plan') errors.push('测试计划尚未完成，不能提交执行结果');
  if (current.header.spec_revision !== current.currentSpecRevision) {
    errors.push('冻结计划绑定的交付契约版本已经变化，需要在新一轮草稿中重新审视计划');
  }
  const missingResults = current.scenarios.filter((scenario) =>
    !current.results.some((result) => result.scenario_key === scenario.scenario_key));
  if (missingResults.length) {
    errors.push(`以下计划场景尚无执行结果：${missingResults.map((item) => item.scenario_key).join(', ')}`);
  }
  if (current.runtimeInputs.some((item) => item.status === 'pending')) {
    errors.push('仍有未回答的运行信息请求，不能提交验证结论');
  }
  return [...new Set(errors)];
}

function evidenceReviewErrors(current: VerificationState) {
  const errors = executionErrors(current);
  if (!current.header.evidence_review_summary?.trim()) errors.push('尚未记录证据复核摘要');
  return [...new Set(errors)];
}

function completionErrors(current: VerificationState, draft: VerificationDraftRow) {
  const errors = evidenceReviewErrors(current);
  if (current.header.workflow_phase !== 'finalize') errors.push('尚未进入 FINALIZE 阶段');
  if (current.header.validated_change_seq !== draft.change_seq) {
    errors.push('当前草稿版本尚未通过 validate，或校验后又发生了变化');
  }
  return [...new Set(errors)];
}

function deriveConclusion(current: VerificationState): DerivedConclusion {
  const failed = current.results.filter((item) => item.status === 'failed');
  if (failed.length) {
    return {
      action: 'fail',
      failureKind: failed.some((item) => item.failure_kind === 'specification')
        ? 'specification'
        : 'implementation',
    };
  }
  const blocked = current.results.filter((item) => item.status === 'blocked');
  if (blocked.length) {
    return {
      action: 'block',
      failureKind: blocked.some((item) => item.failure_kind === 'inconclusive')
        ? 'inconclusive'
        : 'environment',
    };
  }
  return { action: 'pass' };
}

function verificationAssistanceKeyPrefix(scenarioKey: string) {
  const digest = createHash('sha256').update(scenarioKey).digest('hex').slice(0, 16);
  return `verification-assistance:${digest}:`;
}

function verificationAssistanceKey(current: VerificationState, scenarioKey: string) {
  const prefix = verificationAssistanceKeyPrefix(scenarioKey);
  const sequence = current.runtimeInputs.filter((input) =>
    input.request_key.startsWith(prefix)).length + 1;
  return `${prefix}${sequence}`;
}

function verificationAssistanceRequests(current: VerificationState) {
  return current.results
    .filter((result) => result.status === 'blocked')
    .filter((result) => !current.runtimeInputs.some((input) =>
      input.request_key.startsWith(verificationAssistanceKeyPrefix(result.scenario_key))
      && (input.status === 'pending' || input.status === 'answered')))
    .map((result): RuntimeInputSubmission => {
      const scenario = current.scenarios.find((item) =>
        item.scenario_key === result.scenario_key)!;
      return {
        key: verificationAssistanceKey(current, scenario.scenario_key),
        title: `需要协助验证：${scenario.title}`,
        question: [
          'Test Agent 当前无法独立完成这个场景。',
          `场景：${scenario.title}`,
          `准备：${scenario.setup}`,
          `步骤：${scenario.steps}`,
          `期望：${scenario.expected}`,
          '请补充继续验证所需的依赖、环境或操作条件；你也可以代为执行，并填写通过/失败、实际观察和可定位证据。',
        ].join('\n'),
        why: [
          `受阻状态：${result.actual_behavior || '尚未取得可判定结果'}`,
          `已有观察：${result.evidence}`,
        ].join('\n'),
        recommendation: '提供缺少的测试条件后由 Test Agent 继续；或回复“人工验证：通过/失败；实际观察：…；证据：…”。',
      };
    });
}

type Readiness = { status: 'not_ready' | 'ready' | 'input_required'; remaining: string[]; nextCommand: string };

function readiness(current: VerificationState, draft: VerificationDraftRow, phase = current.header.workflow_phase): Readiness {
  const pendingInput = current.runtimeInputs.some((item) => item.status === 'pending');
  if (pendingInput && (phase === 'plan' || phase === 'execute')) {
    return { status: 'input_required', remaining: ['仍有未回答的运行信息请求'], nextCommand: 'verification request-input' };
  }
  const remaining = phase === 'plan'
    ? planErrors(current)
    : phase === 'execute'
      ? executionErrors(current)
      : phase === 'evidence_review'
        ? evidenceReviewErrors(current)
        : evidenceReviewErrors(current);
  return {
    status: remaining.length ? 'not_ready' : 'ready',
    remaining,
    nextCommand: phase === 'finalize' && current.header.validated_change_seq !== draft.change_seq
      ? 'verification validate'
      : VERIFICATION_WORKFLOW[phase].submit,
  };
}

function renderCommandResult(input: { command: string; outcome: string; details?: string[] }) {
  return [
    '# COMMAND RESULT', '',
    `- Command: \`${input.command}\``,
    `- Outcome: ${input.outcome}`,
    ...(input.details || []).map((item) => `- ${item}`),
  ].join('\n');
}

function renderReadiness(current: VerificationState, draft: VerificationDraftRow, phase: VerificationPhase) {
  const value = readiness(current, draft, phase);
  const definition = VERIFICATION_WORKFLOW[phase];
  const lines = ['## READINESS', '', `- Status: ${value.status}`];
  if (value.status === 'not_ready') {
    lines.push('- Remaining:', ...value.remaining.map((item) => `  - ${item}`), '', '- Action: continue_current_work_packet', '- Refresh: `verification status`');
  } else if (value.status === 'input_required') {
    lines.push('', '## SUBMIT INPUT REQUEST', '', '`verification request-input`');
  } else {
    lines.push('', '## REVIEW BEFORE SUBMIT', '', ...definition.reviewBeforeSubmit.map((item) => `- ${item}`), '', phase === 'finalize' ? '## VALIDATE OR SUBMIT' : '## SUBMIT', '', `\`${value.nextCommand}\``);
  }
  return lines;
}

function renderWorkPacket(current: VerificationState, draft: VerificationDraftRow, phase = current.header.workflow_phase) {
  const definition = VERIFICATION_WORKFLOW[phase];
  return [
    '# NEXT WORK PACKET', '',
    '## PHASE', '', `${definition.title} · ${phase}`, '',
    '## OBJECTIVE', '', definition.objective, '',
    '## REQUIRED', '', definition.required, '',
    '## DO NOT', '', definition.prohibited, '',
    '## AVAILABLE COMMANDS', '', ...definition.commands.map((item) => `- \`${item}\``), '',
    ...renderReadiness(current, draft, phase),
  ].join('\n');
}

function renderContinue(command: string, changed: string, current: VerificationState, draft: VerificationDraftRow) {
  const value = readiness(current, draft);
  const definition = VERIFICATION_WORKFLOW[current.header.workflow_phase];
  const lines = [
    renderCommandResult({ command, outcome: 'accepted', details: [`Changed: ${changed}`] }), '',
    '# NEXT', '',
    `- Phase: ${current.header.workflow_phase}`,
    `- Readiness: ${value.status}`,
  ];
  if (value.status === 'not_ready') {
    lines.push('- Action: continue_current_work_packet', '- Remaining:', ...value.remaining.map((item) => `  - ${item}`), '- Refresh: `verification status`');
  } else if (value.status === 'input_required') {
    lines.push('- Action: `verification request-input`');
  } else {
    lines.push('- Action: review_before_submit', '- Review:', ...definition.reviewBeforeSubmit.map((item) => `  - ${item}`), `- ${current.header.workflow_phase === 'finalize' ? 'Validate or Submit' : 'Submit'}: \`${value.nextCommand}\``);
  }
  return lines.join('\n');
}

function renderStatus(draft: VerificationDraftRow, current: VerificationState) {
  const covered = coveredRefs(current);
  const lines = [
    renderCommandResult({ command: 'verification status', outcome: 'state_restored' }),
    '',
    `# CURRENT DRAFT`, '',
    `验证草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    `阶段：${VERIFICATION_WORKFLOW[current.header.workflow_phase].title}`,
    `调用链：${VERIFICATION_PHASE_SEQUENCE}`,
    `交付契约：当前 revision ${current.currentSpecRevision ?? '不可用'} · 计划绑定 ${current.header.spec_revision ?? '未冻结'}`,
    '',
    `计划场景：${current.scenarios.length}（前端 ${current.scenarios.filter((item) => item.channel === 'frontend').length} / API ${current.scenarios.filter((item) => item.channel === 'api').length}）`,
    `执行结果：${current.results.length}/${current.scenarios.length}（通过 ${current.results.filter((item) => item.status === 'passed').length} / 失败 ${current.results.filter((item) => item.status === 'failed').length} / 阻塞 ${current.results.filter((item) => item.status === 'blocked').length}）`,
    `运行信息与验证协助：${current.runtimeInputs.length}（已回答 ${current.runtimeInputs.filter((item) => item.answer).length}）`,
  ];
  if (current.requiredRefs.length) {
    lines.push('', '必测引用（plan --covers 使用下列稳定 ref）：');
    for (const ref of current.requiredRefs) {
      lines.push(`- ${ref.key} · ${ref.kind} · ${covered.has(ref.key) ? '已覆盖' : '未覆盖'}：${ref.description} · Oracle：${ref.oracle}`);
    }
  }
  if (current.scenarios.length) {
    lines.push('', '测试计划：');
    for (const scenario of current.scenarios) {
      const result = current.results.find((item) => item.scenario_key === scenario.scenario_key);
      lines.push(`- ${scenario.scenario_key} · ${scenario.channel} · ${result?.status || '待执行'} · 覆盖 ${scenario.coverageRefs.join(', ')}：${scenario.title}`);
    }
  }
  if (current.runtimeInputs.length) {
    lines.push('', '运行信息与验证协助（request key 跨轮次不可改名）：');
    for (const input of current.runtimeInputs) {
      lines.push(`- ${input.request_key}：${input.title} · ${input.answer ? `已回答=${input.answer}` : '待回答'}`);
    }
  }
  if (current.header.evidence_review_summary) {
    lines.push('', '证据复核：', `- 摘要：${current.header.evidence_review_summary}`);
    if (current.header.residual_risk) lines.push(`- 残余风险：${current.header.residual_risk}`);
  }
  return [lines.join('\n'), '', renderWorkPacket(current, draft)].join('\n');
}

function renderArtifact(
  current: VerificationState,
  conclusion?: DerivedConclusion,
) {
  const conclusionLabel = conclusion?.action === 'pass'
    ? '通过'
    : conclusion?.action === 'fail'
      ? '失败并回流'
      : conclusion?.action === 'block'
        ? '等待验证协助'
        : '等待运行信息';
  const lines = [
    '# 独立验证报告',
    '',
    `## 结论：${conclusionLabel}`,
    '',
    `交付契约 revision：${current.header.spec_revision ?? '未冻结'}`,
    '',
    '## 测试计划与执行结果',
    '',
  ];
  const channelLabels = { frontend: '前端', api: 'API' } as const;
  const statusLabels = { passed: '通过', failed: '失败', blocked: '受阻' } as const;
  const failureLabels = { implementation: '实现问题', specification: '规格问题', environment: '环境条件', inconclusive: '证据不足' } as const;
  for (const scenario of current.scenarios) {
    const result = current.results.find((item) => item.scenario_key === scenario.scenario_key);
    lines.push(
      `### ${scenario.title} · ${channelLabels[scenario.channel]} · ${result ? statusLabels[result.status] : '未执行'}`,
      '',
      `- 准备：${scenario.setup}`,
      `- 测试步骤：${scenario.steps}`,
      `- 期望：${scenario.expected}`,
      `- 证据：${result?.evidence || '尚无'}`,
    );
    if (result?.actual_behavior) lines.push(`- 实际：${result.actual_behavior}`);
    if (result?.failure_kind) lines.push(`- 责任边界：${failureLabels[result.failure_kind]}`);
    lines.push('');
  }
  lines.push('## 证据复核', '', current.header.evidence_review_summary || '尚未完成证据复核', '', '## 残余风险', '');
  lines.push(current.header.residual_risk ? `- ${current.header.residual_risk}` : '- 未发现已知残余风险');
  return lines.join('\n');
}

function buildCompleteResult(
  current: VerificationState,
  draft: VerificationDraftRow,
) {
  const conclusion = deriveConclusion(current);
  const passed = current.results.filter((item) => item.status === 'passed').length;
  const failed = current.results.filter((item) => item.status === 'failed').length;
  const blocked = current.results.filter((item) => item.status === 'blocked').length;
  const assistanceRequests = verificationAssistanceRequests(current);
  const summary = conclusion.action === 'pass'
    ? `独立验证通过：${current.results.length} 个计划场景全部符合冻结交付契约`
    : conclusion.action === 'fail'
      ? `独立验证失败：${failed} 个场景发现产品行为偏差（通过 ${passed}，阻塞 ${blocked}）`
      : `独立验证需要协助：${blocked} 个场景暂时无法形成可靠判定（通过 ${passed}）`;
  return agentResultSchema.parse({
    outcome: conclusion.action === 'block' ? 'needs_input' : 'completed',
    summary,
    artifact: {
      title: '独立验证报告',
      content: renderArtifact(current, conclusion),
    },
    ...(conclusion.action === 'block'
      ? { runtimeInputs: assistanceRequests }
      : { verdict: conclusion.action === 'pass' ? 'passed' : 'failed' }),
    ...(conclusion.failureKind
      && conclusion.action !== 'block' ? {
        failureKind: conclusion.failureKind,
        ...(conclusion.action === 'fail'
          ? {
            rewindTo: conclusion.failureKind === 'specification' ? 'analysis' : 'dev',
            rewindDeliveryUnit: draft.story_index || undefined,
          }
          : {}),
      }
      : {}),
    tests: current.scenarios.map((scenario) => {
      const result = current.results.find((item) => item.scenario_key === scenario.scenario_key)!;
      return {
        command: `[${scenario.channel}] ${scenario.title}`,
        passed: result.status === 'passed',
        summary: `${result.evidence}${result.actual_behavior ? `；实际：${result.actual_behavior}` : ''}`,
      };
    }),
  });
}

function buildInputResult(current: VerificationState, input: RuntimeInputSubmission) {
  return agentResultSchema.parse({
    outcome: 'needs_input',
    summary: `独立验证缺少运行资源或信息：${input.title}`,
    artifact: {
      title: '独立验证进行中',
      content: renderArtifact(current),
    },
    runtimeInputs: [input],
  });
}

function terminalSubmit(
  db: Db,
  draft: VerificationDraftRow,
  execution: VerificationExecutionRow,
  action: 'complete' | 'request-input',
  options?: {
    runtimeInput?: RuntimeInputSubmission;
  },
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft);
  const runtimeInput = options?.runtimeInput;
  if (action === 'complete') {
    const errors = completionErrors(current, draft);
    if (errors.length) {
      throw new Error(`验证草稿不能执行 complete：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }
  } else if (!runtimeInput) {
    throw new Error('缺少要提交的运行信息请求');
  }
  const result = action === 'complete'
    ? buildCompleteResult(current, draft)
    : buildInputResult(current, runtimeInput!);
  if (result.outcome === 'needs_input' && !result.runtimeInputs.length) {
    throw new Error(
      '验证协助已经有待处理或已回答记录。请根据 status 中的回答重新执行场景并更新结果；'
      + '仍需其他协助时使用新的 request key。',
    );
  }
  const status = result.outcome === 'needs_input' ? 'waiting_for_answers' : 'submitted';
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
  if (action === 'request-input') {
    return [
      renderCommandResult({ command: 'verification request-input', outcome: 'waiting_for_human' }),
      '', '# NEXT', '', '- Owner: Application', '- Agent Action: wait_for_human',
    ].join('\n');
  }
  const conclusion = deriveConclusion(current).action;
  return [
    renderCommandResult({
      command: 'verification complete',
      outcome: conclusion === 'pass' ? 'completed' : conclusion === 'fail' ? 'failed' : 'waiting_for_human',
    }),
    '', '# NEXT', '', '- Owner: Application', `- Agent Action: ${conclusion === 'block' ? 'wait_for_human' : 'end_execution'}`,
  ].join('\n');
}

export function verificationHelp(
  _terminalActions: string[],
  topic?: string | null,
) {
  if (topic === 'plan') {
    return [
      '测试计划阶段：',
      '  verification plan upsert --key <稳定 key> --channel <frontend|api> --title <场景> --setup <前置条件与测试数据> --steps <入口与测试动作> --expected <可观察期望> --covers <status 中的 ref，多个用逗号分隔>',
      '    逐项建立面向业务预期的黑盒场景；修改同一场景时复用 key。',
      '    setup 说明执行前需要成立的条件与数据；steps 从真实入口开始描述用户或 API 动作。',
      '    每项交付单元验收必须至少由一个 frontend 场景覆盖真实业务闭环；API 场景可以补充业务证据或形成反例。',
      '  verification plan dismiss --key <场景 key>',
      '    只在计划冻结前移除错误或重复场景。',
      '  verification plan complete',
      '    最低覆盖完整后冻结 Expected 并进入 EXECUTE；之后只能追加新发现的场景。',
    ];
  }
  if (topic === 'execute') {
    return [
      '测试执行阶段：',
      '  verification result record --key <场景 key> --status <passed|failed|blocked> --evidence <独立证据> [--kind <implementation|specification|environment|inconclusive>] [--actual <实际行为或阻塞状态>]',
      '    按计划记录实际观察。failed 使用 implementation/specification；blocked 使用 environment/inconclusive。',
      '    blocked 只报告当前无法完成的验证事实；Application 会自动请求用户补充条件或代为验证，不会把它当作系统故障。',
      '  verification execute complete',
      '    全部活动场景都有独立结果后进入 EVIDENCE REVIEW。',
    ];
  }
  if (topic === 'evidence') {
    return [
      '证据复核阶段：',
      '  verification evidence-review record --summary <证据是否支持状态与责任分类的复核结论> [--risk <不影响本次结论的残余风险>]',
      '  verification evidence-review reopen-execution --reason <证据或分类需要重做的原因>',
      '  verification evidence-review complete',
      '    本阶段不能修改场景或结果；发现证据不充分时必须显式回流 EXECUTE。',
    ];
  }
  if (topic === 'input') {
    return [
      '运行信息：',
      '  verification request-input --key <稳定 key> --title <标题> --question <问题> --why <原因> [--recommendation <建议>]',
      '    仅在测试地址、账号、设备条件或测试数据等必要资源无法自行取得时使用；命令成功后结束本轮。',
    ];
  }
  if (topic === 'finish') {
    return [
      '完成验证：',
      '  verification validate',
      '  verification finalize reopen-evidence-review --reason <最终一致性问题>',
      '  verification complete',
      '    validate 绑定当前草稿版本；之后无编辑或回流时，由 Application 根据结果确定通过、回流或验证协助。',
    ];
  }
  if (topic) {
    throw new Error(`验证 help 不支持主题：${topic}。可用主题：context、plan、execute、evidence、input、finish`);
  }
  return [
    '  verification status',
    '  verification plan upsert --key <稳定 key> --channel <frontend|api> --title <场景> --setup <前置条件与测试数据> --steps <入口与测试动作> --expected <可观察期望> --covers <status 中的 ref，多个用逗号分隔>',
    '  verification plan dismiss --key <场景 key>',
    '  verification plan complete',
    '  verification result record --key <场景 key> --status <passed|failed|blocked> --evidence <独立证据> [--kind <implementation|specification|environment|inconclusive>] [--actual <实际行为或阻塞状态>]',
    '  verification execute complete',
    '  verification evidence-review record --summary <复核结论> [--risk <残余风险>]',
    '  verification evidence-review reopen-execution --reason <原因>',
    '  verification evidence-review complete',
    '  verification validate',
    '  verification finalize reopen-evidence-review --reason <原因>',
    '  verification complete',
    '  verification request-input --key <稳定 key> --title <标题> --question <问题> --why <原因> [--recommendation <建议>]',
    '',
    '主题帮助：',
    '  help context  只读上下文工具与使用时机',
    '  help plan     建立并冻结 Expected',
    '  help execute  逐项记录黑盒测试结果',
    '  help evidence 复核证据与责任分类',
    '  help input    缺少执行资源时请求运行信息',
    '  help finish   完成条件与确定性结论',
  ];
}

function transitionPhase(input: {
  db: Db;
  draft: VerificationDraftRow;
  execution: VerificationExecutionRow;
  from: VerificationPhase;
  to: VerificationPhase;
}) {
  const { db, draft, execution, from, to } = input;
  const current = state(db, draft);
  if (current.header.workflow_phase !== from) {
    throw new Error(`当前阶段是 ${current.header.workflow_phase}，不能提交 ${from}`);
  }
  const errors = from === 'plan'
    ? planErrors(current)
    : from === 'execute'
      ? executionErrors(current)
      : evidenceReviewErrors(current);
  if (errors.length) {
    throw new Error(`${from} 阶段不能完成：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE verification_drafts
      SET workflow_phase = ?, phase = CASE WHEN ? = 'plan' THEN 'planning' ELSE 'executing' END,
          spec_revision = CASE WHEN ? = 'plan' THEN ? ELSE spec_revision END,
          validated_change_seq = NULL
      WHERE draft_id = ?
    `).run(to, to, from, current.currentSpecRevision, draft.draft_id);
    db.prepare(`
      INSERT INTO verification_phase_transitions(draft_id, from_phase, to_phase, reason, execution_id)
      VALUES(?, ?, ?, ?, ?)
    `).run(draft.draft_id, from, to, `${from} 阶段产物校验通过`, execution.execution_id);
    touchDraft(db, draft.draft_id);
  })();
  const next = state(db, draft);
  return [
    renderCommandResult({ command: VERIFICATION_WORKFLOW[from].submit, outcome: 'phase_completed', details: [`From: ${from}`, `To: ${to}`] }),
    '', renderWorkPacket(next, { ...draft, change_seq: draft.change_seq + 1 }, to),
  ].join('\n');
}

function reopenPhase(input: {
  db: Db;
  draft: VerificationDraftRow;
  execution: VerificationExecutionRow;
  command: string;
  from: VerificationPhase;
  to: VerificationPhase;
  reason: string;
}) {
  const { db, draft, execution, command, from, to, reason } = input;
  const current = state(db, draft);
  if (current.header.workflow_phase !== from) {
    throw new Error(`只有 ${from} 阶段可以执行该回流；当前阶段是 ${current.header.workflow_phase}`);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE verification_drafts
      SET workflow_phase = ?, phase = 'executing', validated_change_seq = NULL,
          evidence_review_summary = NULL, residual_risk = NULL
      WHERE draft_id = ?
    `).run(to, draft.draft_id);
    db.prepare(`
      INSERT INTO verification_phase_transitions(draft_id, from_phase, to_phase, reason, execution_id)
      VALUES(?, ?, ?, ?, ?)
    `).run(draft.draft_id, from, to, reason, execution.execution_id);
    touchDraft(db, draft.draft_id);
  })();
  const next = state(db, draft);
  return [
    renderCommandResult({ command, outcome: 'phase_completed', details: [`From: ${from}`, `To: ${to}`, `Reason: ${reason}`] }),
    '', renderWorkPacket(next, { ...draft, change_seq: draft.change_seq + 1 }, to),
  ].join('\n');
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
    ['verification complete', 'verification request-input'].includes(command)
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === command.replace('verification ', '')
  ) {
    return renderCommandResult({ command, outcome: 'already_submitted' });
  }
  assertViewed(draft, execution.execution_id);

  if (command === 'verification plan upsert') {
    const current = state(db, draft);
    const key = bounded(required(flags, 'key'), '场景 key', 120);
    const existing = current.scenarios.find((item) => item.scenario_key === key);
    if (current.header.workflow_phase !== 'plan' && current.header.workflow_phase !== 'execute') {
      throw new Error(`只有 PLAN 或 EXECUTE 阶段可以维护场景；当前阶段是 ${current.header.workflow_phase}`);
    }
    if (current.header.workflow_phase === 'execute' && existing) {
      throw new Error(`测试计划已经 freeze，不能修改既有场景 ${key}；发现新风险时请使用新的稳定 key 追加场景`);
    }
    const channel = required(flags, 'channel');
    if (!['frontend', 'api'].includes(channel)) {
      throw new Error('--channel 必须是 frontend 或 api');
    }
    const ordinal = nextOrdinal(db, 'verification_plan_scenarios', draft.draft_id);
    db.prepare(`
      INSERT INTO verification_plan_scenarios(
        draft_id, scenario_key, channel, title, setup, steps,
        expected, coverage_refs_json, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, scenario_key) DO UPDATE SET
        channel = excluded.channel,
        title = excluded.title,
        setup = excluded.setup,
        steps = excluded.steps,
        expected = excluded.expected,
        coverage_refs_json = excluded.coverage_refs_json
    `).run(
      draft.draft_id,
      key,
      channel,
      bounded(required(flags, 'title'), '场景标题', 240),
      bounded(required(flags, 'setup'), '测试准备', 10000),
      bounded(required(flags, 'steps'), '测试步骤', 10000),
      bounded(required(flags, 'expected'), '可观察期望'),
      JSON.stringify(parseCoverageRefs(required(flags, 'covers'))),
      ordinal,
    );
    invalidateValidation(db, draft.draft_id);
    const next = state(db, draft);
    return renderContinue(command, current.header.workflow_phase === 'plan' ? `测试场景 ${key}` : `新增风险场景 ${key}`, next, { ...draft, change_seq: draft.change_seq + 1 });
  }
  if (command === 'verification plan dismiss') {
    const current = state(db, draft);
    if (current.header.workflow_phase !== 'plan') {
      throw new Error('只有 PLAN 阶段可以删除场景');
    }
    const key = required(flags, 'key');
    const removed = db.prepare(`
      DELETE FROM verification_plan_scenarios
      WHERE draft_id = ? AND scenario_key = ?
    `).run(draft.draft_id, key);
    if (!removed.changes) throw new Error(`测试计划场景不存在：${key}`);
    invalidateValidation(db, draft.draft_id);
    return renderContinue(command, `删除测试场景 ${key}`, state(db, draft), { ...draft, change_seq: draft.change_seq + 1 });
  }
  if (command === 'verification plan complete') {
    return transitionPhase({ db, draft, execution, from: 'plan', to: 'execute' });
  }
  if (command === 'verification result record') {
    const current = state(db, draft);
    if (current.header.workflow_phase !== 'execute') {
      throw new Error(`只有 EXECUTE 阶段可以记录执行结果；当前阶段是 ${current.header.workflow_phase}`);
    }
    const key = bounded(required(flags, 'key'), '场景 key', 120);
    if (!current.scenarios.some((item) => item.scenario_key === key)) {
      throw new Error(`测试计划中不存在场景：${key}`);
    }
    const status = required(flags, 'status');
    if (!['passed', 'failed', 'blocked'].includes(status)) {
      throw new Error('--status 必须是 passed、failed 或 blocked');
    }
    const kind = flags.get('kind')?.trim() || null;
    const actual = optionalBounded(flags, 'actual', '实际行为或阻塞状态');
    if (status === 'passed') {
      if (kind) throw new Error('passed 结果不能设置 --kind');
    } else if (status === 'failed') {
      if (!['implementation', 'specification'].includes(kind || '')) {
        throw new Error('failed 结果的 --kind 必须是 implementation 或 specification');
      }
      if (!actual) throw new Error('failed 结果必须提供 --actual');
    } else {
      if (!['environment', 'inconclusive'].includes(kind || '')) {
        throw new Error('blocked 结果的 --kind 必须是 environment 或 inconclusive');
      }
      if (!actual) throw new Error('blocked 结果必须提供 --actual');
    }
    const ordinal = nextOrdinal(db, 'verification_results', draft.draft_id);
    db.prepare(`
      INSERT INTO verification_results(
        draft_id, scenario_key, status, failure_kind, evidence, actual_behavior, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, scenario_key) DO UPDATE SET
        status = excluded.status,
        failure_kind = excluded.failure_kind,
        evidence = excluded.evidence,
        actual_behavior = excluded.actual_behavior
    `).run(
      draft.draft_id,
      key,
      status,
      kind,
      bounded(required(flags, 'evidence'), '独立验证证据', 10000),
      actual,
      ordinal,
    );
    invalidateValidation(db, draft.draft_id);
    return renderContinue(command, `测试场景 ${key} 的 ${status} 结果`, state(db, draft), { ...draft, change_seq: draft.change_seq + 1 });
  }
  if (command === 'verification execute complete') {
    return transitionPhase({ db, draft, execution, from: 'execute', to: 'evidence_review' });
  }
  if (command === 'verification evidence-review record') {
    const current = state(db, draft);
    if (current.header.workflow_phase !== 'evidence_review') {
      throw new Error(`只有 EVIDENCE REVIEW 阶段可以记录证据复核；当前阶段是 ${current.header.workflow_phase}`);
    }
    db.prepare(`
      UPDATE verification_drafts
      SET evidence_review_summary = ?, residual_risk = ?, validated_change_seq = NULL
      WHERE draft_id = ?
    `).run(
      bounded(required(flags, 'summary'), '证据复核摘要', 10000),
      optionalBounded(flags, 'risk', '残余风险', 10000),
      draft.draft_id,
    );
    touchDraft(db, draft.draft_id);
    return renderContinue(command, '证据复核结论与残余风险', state(db, draft), { ...draft, change_seq: draft.change_seq + 1 });
  }
  if (command === 'verification evidence-review reopen-execution') {
    return reopenPhase({ db, draft, execution, command, from: 'evidence_review', to: 'execute', reason: bounded(required(flags, 'reason'), '回流原因', 4000) });
  }
  if (command === 'verification evidence-review complete') {
    return transitionPhase({ db, draft, execution, from: 'evidence_review', to: 'finalize' });
  }
  if (command === 'verification finalize reopen-evidence-review') {
    return reopenPhase({ db, draft, execution, command, from: 'finalize', to: 'evidence_review', reason: bounded(required(flags, 'reason'), '回流原因', 4000) });
  }
  if (command === 'verification validate') {
    const current = state(db, draft);
    if (current.header.workflow_phase !== 'finalize') throw new Error('只有 FINALIZE 阶段可以执行 validate');
    const errors = evidenceReviewErrors(current);
    if (errors.length) throw new Error(`验证草稿校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    db.prepare(`UPDATE verification_drafts SET validated_change_seq = ? WHERE draft_id = ?`).run(draft.change_seq, draft.draft_id);
    return [
      renderCommandResult({ command, outcome: 'validation_passed', details: [`Validated Change: ${draft.change_seq}`] }), '',
      '# NEXT', '', '- Phase: finalize', '- Readiness: ready', '- Submit: `verification complete`',
    ].join('\n');
  }
  if (command === 'verification request-input') {
    const phase = state(db, draft).header.workflow_phase;
    if (!['plan', 'execute'].includes(phase)) {
      throw new Error(`只有 PLAN 或 EXECUTE 阶段可以请求运行信息；当前阶段是 ${phase}`);
    }
    const key = bounded(required(flags, 'key'), '运行信息 key', 120);
    const existing = state(db, draft).runtimeInputs.find((item) => item.request_key === key);
    if (existing) {
      throw new Error(existing.answer
        ? `运行信息 ${key} 已回答；请消费已有回答，新的资源问题必须使用新的稳定 key`
        : `运行信息 ${key} 已在等待回答，不能重复提交`);
    }
    return terminalSubmit(db, draft, execution, 'request-input', {
      runtimeInput: {
        key,
        title: bounded(required(flags, 'title'), '运行信息标题', 200),
        question: bounded(required(flags, 'question'), '运行信息问题'),
        why: bounded(required(flags, 'why'), '请求原因', 1000),
        recommendation: optionalBounded(flags, 'recommendation', '建议', 2000) || '',
      },
    });
  }
  if (command === 'verification complete') {
    return terminalSubmit(db, draft, execution, 'complete');
  }
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}
