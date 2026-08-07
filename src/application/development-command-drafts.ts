import { agentResultSchema, deliverySpecSchema } from '../domain/agent-result';
import {
  DEVELOPMENT_PHASE_ORDER,
  DEVELOPMENT_PHASE_SEQUENCE,
  DEVELOPMENT_WORKFLOW,
  developmentNormalCommandPath,
  type DevelopmentPhase,
} from '../domain/development-workflow';
import { gitHead, gitWorkingTreeChanges } from '../infrastructure/git';
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

type CapturedToolEvent = {
  name?: string;
  phase?: 'started' | 'completed';
  tool?: string;
  toolClass?: 'shell' | 'other' | 'unknown';
  toolCallId?: string;
  sequence?: number;
  summary?: string;
  input?: unknown;
  output?: unknown;
  success?: boolean;
  exitCode?: number | null;
  commandHash?: string;
  originalLength?: number;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
};

type CapturedCommand = {
  receiptKey: string;
  command: string;
  commandHash: string;
  originalLength: number;
  passed: boolean;
  summary: string;
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

function assertViewed(draft: DevelopmentDraftRow, executionId: string) {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error('本次启动尚未查看草稿状态。请先执行 implementation status，再继续编辑或提交');
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function commandFromValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof record[key] === 'string') return record[key].trim();
  }
  return '';
}

function isHarnessCommand(command: string) {
  const normalized = command.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/scripts/loop/loop-agent.mjs')
    || normalized.includes(' loopctl -- agent-context')
    || normalized.includes(' agent-context ');
}

function capturedCommands(db: Db, executionId: string): CapturedCommand[] {
  const rows = db.prepare(`
    SELECT receipt_key, payload_json
    FROM execution_receipts
    WHERE execution_id = ? AND kind = 'tool_event'
    ORDER BY receipt_key
  `).all(executionId) as { receipt_key: string; payload_json: string }[];
  const commands: CapturedCommand[] = [];
  for (const row of rows) {
    let event: CapturedToolEvent;
    try {
      event = JSON.parse(row.payload_json) as CapturedToolEvent;
    } catch {
      continue;
    }
    if (event.name !== 'loop.agent.tool' || event.phase !== 'completed') continue;
    const command = commandFromValue(event.input);
    if (!command || isHarnessCommand(command)) continue;
    commands.push({
      receiptKey: row.receipt_key,
      command: command.slice(0, 2000),
      commandHash: typeof event.commandHash === 'string' ? event.commandHash : '',
      originalLength: typeof event.originalLength === 'number'
        ? event.originalLength
        : command.length,
      passed: event.toolClass === 'shell'
        && event.success === true
        && event.level !== 'ERROR',
      summary: (event.summary || (event.success === true ? '命令执行完成' : '命令执行失败或状态未知')).slice(0, 500),
    });
  }
  return commands;
}

function repositoryObservation() {
  const head = gitHead(paths.root);
  return {
    head,
    changes: gitWorkingTreeChanges(paths.root),
  };
}

function state(db: Db, draft: DevelopmentDraftRow, execution: DevelopmentExecutionRow) {
  const contract = db.prepare(`
    SELECT workflow_phase, validated_change_seq,
           review_result, review_summary, review_evidence
    FROM development_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    workflow_phase: DevelopmentPhase;
    validated_change_seq: number | null;
    review_result: 'pass' | 'needs_changes' | null;
    review_summary: string | null;
    review_evidence: string | null;
  };
  const criteria = db.prepare(`
    SELECT criterion_key, evidence, ordinal
    FROM development_criteria WHERE draft_id = ? ORDER BY ordinal, criterion_key
  `).all(draft.draft_id) as {
    criterion_key: string;
    evidence: string;
    ordinal: number;
  }[];
  const checks = db.prepare(`
    SELECT check_key, command, command_hash, summary, source_execution_id, source_receipt_key,
           ordinal
    FROM development_checks WHERE draft_id = ? ORDER BY ordinal, check_key
  `).all(draft.draft_id) as {
    check_key: string;
    command: string;
    command_hash: string;
    summary: string;
    source_execution_id: string;
    source_receipt_key: string;
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
  const activeRecoveries = db.prepare(`
    SELECT recovery_id, summary, target_stage, status, source_agent, failure_count
    FROM recovery_items
    WHERE task_id = ? AND story_index IS ?
      AND status IN ('pending', 'claimed', 'reopened')
    ORDER BY created_at, recovery_id
  `).all(draft.task_id, draft.story_index) as {
    recovery_id: string;
    summary: string;
    target_stage: 'analysis' | 'dev';
    status: 'pending' | 'claimed' | 'reopened';
    source_agent: string;
    failure_count: number;
  }[];
  const specRow = db.prepare(`
    SELECT spec_json
    FROM story_specs
    WHERE task_id = ? AND story_index = ? AND status = 'resolved'
    ORDER BY revision DESC LIMIT 1
  `).get(draft.task_id, draft.story_index) as { spec_json: string } | undefined;
  let expectedCriteria: { id: string; description: string; oracle: string }[] = [];
  let deliveryConstraints: string[] = [];
  try {
    const parsed = specRow ? deliverySpecSchema.parse(JSON.parse(specRow.spec_json)) : null;
    expectedCriteria = parsed
      ? [{
            id: 'unit-acceptance',
            description: parsed.unit.acceptance,
            oracle: parsed.unit.observableOutcome,
          }, ...parsed.handoff.verificationFocus.map((focus) => ({
            id: focus.key,
            description: focus.expected,
            oracle: focus.oracle,
          }))]
      : [];
    deliveryConstraints = parsed ? [
      ...parsed.impacts.map((impact) =>
        `${impact.disposition} · ${impact.area}：${impact.finding}`),
      ...parsed.handoff.guardrails.map((guardrail) =>
        `guardrail · ${guardrail.content}`),
    ] : [];
  } catch {
    // saveDeliverySpec validates JSON before persistence; report the unreadable contract below.
  }
  return {
    contract,
    criteria,
    checks,
    risks,
    runtimeInputs: runtimeInputs.map((item) => ({
      ...item,
      answer: answerMap.get(item.request_key)?.answer || null,
      answerStatus: answerMap.get(item.request_key)?.status || null,
    })),
    recovery,
    activeRecoveries,
    executionId: execution.execution_id,
    expectedCriteria,
    deliveryConstraints,
    capturedCommands: capturedCommands(db, execution.execution_id),
    repository: repositoryObservation(),
  };
}

type DevelopmentState = ReturnType<typeof state>;

function completionChecks(current: DevelopmentState) {
  return current.activeRecoveries.length
    ? current.checks.filter((item) => item.source_execution_id === current.executionId)
    : current.checks;
}

function activeRecoveryDeclarations(current: DevelopmentState) {
  const activeIds = new Set(current.activeRecoveries.map((item) => item.recovery_id));
  return current.recovery.filter((item) => activeIds.has(item.recovery_id));
}

function implementationErrors(current: DevelopmentState) {
  const errors: string[] = [];
  if (!current.expectedCriteria.length) errors.push('当前交付单元没有可读取的已收敛交付规格验收标准');
  const expectedKeys = new Set(current.expectedCriteria.map((item) => item.id));
  const unknownKeys = current.criteria
    .map((item) => item.criterion_key)
    .filter((key) => !expectedKeys.has(key));
  if (unknownKeys.length) errors.push(`验收证据引用了不存在的规格 key：${unknownKeys.join(', ')}`);
  const missingKeys = current.expectedCriteria
    .map((item) => item.id)
    .filter((key) => !current.criteria.some((item) => item.criterion_key === key));
  if (missingKeys.length) errors.push(`以下验收语义尚未证明：${missingKeys.join(', ')}`);
  const declaredRecoveryIds = new Set(current.recovery.map((item) => item.recovery_id));
  const missingRecoveries = current.activeRecoveries
    .filter((item) => !declaredRecoveryIds.has(item.recovery_id));
  if (missingRecoveries.length) {
    errors.push(`以下活动恢复事项尚未声明处理：${missingRecoveries.map((item) => item.recovery_id).join(', ')}`);
  }
  if (current.runtimeInputs.some((item) => !item.answer)) {
    errors.push('仍有未回答的运行信息请求，不能完成当前工作包');
  }
  return [...new Set(errors)];
}

function reviewErrors(current: DevelopmentState) {
  const errors = [...implementationErrors(current)];
  if (!current.contract.review_result) errors.push('缺少代码审查结论');
  if (!current.contract.review_summary?.trim()) errors.push('缺少代码审查摘要');
  if (!current.contract.review_evidence?.trim()) errors.push('缺少可定位的代码审查依据');
  if (current.contract.review_result === 'needs_changes') {
    errors.push('代码审查仍有阻塞修改；必须回流 IMPLEMENT 修正并重新审查');
  }
  return [...new Set(errors)];
}

function developerVerificationErrors(current: DevelopmentState) {
  const errors = [...reviewErrors(current)];
  const checks = completionChecks(current);
  if (!checks.length) {
    errors.push(current.activeRecoveries.length
      ? '当前处于恢复修正周期，至少需要在本次 execution 重新执行并记录一条真实成功检查'
      : '至少需要记录一条由 Application 捕获的真实成功检查');
  }
  const supersededChecks = checks.filter((item) =>
    current.capturedCommands.some((command) =>
      command.commandHash === item.command_hash
      && (
        item.source_execution_id !== current.executionId
        || command.receiptKey > item.source_receipt_key
      )));
  if (supersededChecks.length) {
    errors.push(
      '以下关键检查之后又执行了同一命令，必须选择最新结果重新记录：'
      + supersededChecks.map((item) => item.check_key).join(', '),
    );
  }
  return [...new Set(errors)];
}

function validationErrors(
  current: DevelopmentState,
  terminal: 'complete' | 'request-input' | 'fail' | null = null,
) {
  const errors = terminal === 'complete' || terminal === null
    ? developerVerificationErrors(current)
    : [];
  if (terminal === 'request-input') {
    const unanswered = current.runtimeInputs.filter((item) => !item.answer);
    if (!unanswered.length) errors.push('没有待用户补充的运行信息，不能 request-input');
  }
  return [...new Set(errors)];
}

type DevelopmentReadiness = {
  status: 'not_ready' | 'input_required' | 'structurally_ready';
  remaining: string[];
  nextCommand: string | null;
};

function developmentReadiness(
  current: DevelopmentState,
  phase: DevelopmentPhase,
): DevelopmentReadiness {
  if (current.runtimeInputs.some((item) => !item.answer) && phase !== 'finalize') {
    return {
      status: 'input_required',
      remaining: [],
      nextCommand: 'implementation request-input',
    };
  }
  const remaining = phase === 'implement'
    ? implementationErrors(current)
    : phase === 'review'
      ? reviewErrors(current)
      : phase === 'commit'
        ? []
        : developerVerificationErrors(current);
  if (remaining.length) return { status: 'not_ready', remaining, nextCommand: null };
  return {
    status: 'structurally_ready',
    remaining: [],
    nextCommand: phase === 'finalize'
      ? 'implementation validate'
      : DEVELOPMENT_WORKFLOW[phase].submit,
  };
}

function renderReadiness(current: DevelopmentState, phase: DevelopmentPhase) {
  const readiness = developmentReadiness(current, phase);
  const definition = DEVELOPMENT_WORKFLOW[phase];
  const lines = ['## READINESS', '', `- Status: ${readiness.status}`];
  if (readiness.status === 'not_ready') {
    lines.push(
      '',
      '## REMAINING REQUIREMENTS',
      '',
      ...readiness.remaining.map((item, index) => `${index + 1}. ${item}`),
      '',
      '继续当前工作包；补齐以上缺口后再查看 `implementation status`。',
    );
    return lines;
  }
  if (readiness.status === 'input_required') {
    lines.push('', '## SUBMIT INPUT REQUEST', '', '`implementation request-input`');
    return lines;
  }
  lines.push(
    '',
    '## REVIEW BEFORE SUBMIT',
    '',
    ...definition.reviewBeforeSubmit.map((item) => `- ${item}`),
    '',
    phase === 'finalize' ? '## VALIDATE' : '## SUBMIT',
    '',
    `\`${readiness.nextCommand}\``,
  );
  return lines;
}

function renderWorkPacket(current: DevelopmentState, phase: DevelopmentPhase) {
  const definition = DEVELOPMENT_WORKFLOW[phase];
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

type DevelopmentCommandOutcome =
  | 'state_restored'
  | 'accepted'
  | 'phase_completed'
  | 'validation_passed'
  | 'waiting_for_human'
  | 'completed'
  | 'failed'
  | 'already_submitted';

function renderCommandResult(input: {
  command: string;
  outcome: DevelopmentCommandOutcome;
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

function renderContinue(command: string, changed: string, current: DevelopmentState) {
  const phase = current.contract.workflow_phase;
  const readiness = developmentReadiness(current, phase);
  const definition = DEVELOPMENT_WORKFLOW[phase];
  const next = ['# NEXT', '', `- Phase: ${phase}`, `- Readiness: ${readiness.status}`];
  if (readiness.status === 'not_ready') {
    next.push(
      '- Action: continue_current_work_packet',
      '- Remaining:',
      ...readiness.remaining.map((item) => `  - ${item}`),
      '- Refresh: `implementation status`',
    );
  } else if (readiness.status === 'input_required') {
    next.push('- Action: `implementation request-input`');
  } else {
    next.push(
      '- Action: review_before_submit',
      '- Review:',
      ...definition.reviewBeforeSubmit.map((item) => `  - ${item}`),
      `- ${phase === 'finalize' ? 'Validate' : 'Submit'}: \`${readiness.nextCommand}\``,
    );
  }
  return [
    renderCommandResult({ command, outcome: 'accepted', details: [`Changed: ${changed}`] }),
    '',
    ...next,
  ].join('\n');
}

function renderStatus(draft: DevelopmentDraftRow, current: DevelopmentState) {
  const checks = completionChecks(current);
  const recoveryDeclarations = activeRecoveryDeclarations(current);
  const lines = [
    renderCommandResult({
      command: 'implementation status',
      outcome: 'state_restored',
      details: [`Phase: ${current.contract.workflow_phase}`],
    }),
    '',
    renderWorkPacket(current, current.contract.workflow_phase),
    '',
    '# CURRENT DRAFT',
    '',
    `开发实现草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    '仓库观察（仅供调查，不参与完成校验）：',
    `当前 HEAD：${current.repository.head ? current.repository.head.slice(0, 12) : '不可读'}`,
    `当前未提交项：${current.repository.changes.length}`,
    `验收证据：${current.criteria.length}/${current.expectedCriteria.length}`,
    `代码审查：${current.contract.review_result || '未记录'}`,
    `关键检查：${checks.length}${current.activeRecoveries.length ? `（本次 execution；草稿共 ${current.checks.length}）` : ''}`,
    `风险：${current.risks.length}`,
    `运行信息：${current.runtimeInputs.length}（已回答 ${current.runtimeInputs.filter((item) => item.answer).length}）`,
    `活动恢复事项：${current.activeRecoveries.length}（已声明处理 ${recoveryDeclarations.length}）`,
  ];
  if (current.expectedCriteria.length) {
    lines.push('', '验收语义（必须逐字复用规格 key）：');
    for (const criterion of current.expectedCriteria) {
      const coverage = current.criteria.find((item) => item.criterion_key === criterion.id);
      lines.push(`- ${criterion.id}：${criterion.description} · ${coverage ? `已证明 · ${coverage.evidence}` : '尚未证明'}`);
    }
  }
  if (checks.length) {
    lines.push('', '本轮有效关键检查：', ...checks.map((item) =>
      `- ${item.check_key}：${item.command} · ${item.summary}（execution=${item.source_execution_id.slice(0, 8)} receipt=${item.source_receipt_key}）`));
  }
  if (current.capturedCommands.length) {
    lines.push('', 'Application 最近捕获的命令事实：', ...current.capturedCommands.slice(-8).map((item) =>
      `- ${item.receiptKey} · ${item.passed ? '成功' : '失败'}：${item.command}${item.summary ? ` · ${item.summary}` : ''}`));
  }
  if (current.runtimeInputs.length) {
    lines.push('', '运行信息（request key 跨轮次不可改名）：');
    for (const input of current.runtimeInputs) {
      lines.push(`- ${input.request_key}：${input.title} · ${input.answer ? `已回答=${input.answer}` : '待回答'}`);
    }
  }
  if (current.deliveryConstraints.length) {
    lines.push('', '交付影响与保护约束：', ...current.deliveryConstraints.map((item) => `- ${item}`));
  }
  if (current.contract.review_summary) {
    lines.push(
      '',
      '代码审查：',
      `- 结论：${current.contract.review_result}`,
      `- 摘要：${current.contract.review_summary}`,
      `- 依据：${current.contract.review_evidence}`,
    );
  }
  if (current.activeRecoveries.length) {
    lines.push('', '活动恢复事项（必须逐字复用 RECOVERY id 声明处理）：');
    for (const item of current.activeRecoveries) {
      const declaration = current.recovery.find((entry) => entry.recovery_id === item.recovery_id);
      lines.push(
        `- ${item.recovery_id} · ${item.status} · ${item.target_stage} · ${item.source_agent}`
        + `：${item.summary} · ${declaration ? `已声明：${declaration.summary}（证据：${declaration.evidence}）` : '尚未声明处理'}`,
      );
    }
    lines.push('- 恢复修正周期中的关键检查必须在本次 execution 重新执行并记录；旧检查只作为历史，不计入完成门槛。');
  }
  return lines.join('\n');
}

function renderArtifact(current: DevelopmentState) {
  const checks = completionChecks(current);
  const recoveryDeclarations = activeRecoveryDeclarations(current);
  const lines = [
    '# 开发实现结果',
    '',
    '## 验收证据',
    '',
    ...current.expectedCriteria.map((criterion) => {
      const coverage = current.criteria.find((item) => item.criterion_key === criterion.id);
      return `- ${criterion.description}：${coverage ? `已证明 — ${coverage.evidence}` : '未证明'}`;
    }),
    '',
    '## 代码审查',
    '',
    `- 结论：${current.contract.review_result === 'pass' ? '通过' : '需要修改'}`,
    `- 摘要：${current.contract.review_summary || '未记录'}`,
    `- 依据：${current.contract.review_evidence || '未记录'}`,
    '',
    '## 开发者关键检查',
    '',
    ...(checks.length
      ? checks.map((item) => `- 通过 \`${item.command}\`：${item.summary}`)
      : ['- 尚无关键检查']),
    '',
    '## 已知风险',
    '',
    ...(current.risks.length ? current.risks.map((item) => `- ${item.content}`) : ['- 未发现已知残余风险']),
  ];
  if (recoveryDeclarations.length) {
    lines.push('', '## 恢复事项处理', '');
    for (const item of recoveryDeclarations) {
      lines.push(`- ${item.summary}（证据：${item.evidence}）`);
    }
  }
  return lines.join('\n');
}

function completionSummary(current: DevelopmentState) {
  const checks = completionChecks(current);
  return `开发实现完成：${current.criteria.length}/${current.expectedCriteria.length} 项验收语义已有实现证据，`
    + `${checks.length} 项开发检查通过。`;
}

function buildResult(
  current: DevelopmentState,
  action: 'complete' | 'request-input' | 'fail',
  failureReason?: string,
) {
  const unanswered = current.runtimeInputs.filter((item) => !item.answer);
  const checks = completionChecks(current);
  const recoveryDeclarations = activeRecoveryDeclarations(current);
  const summary = action === 'complete'
    ? completionSummary(current)
    : action === 'request-input'
      ? `需要补充运行信息：${unanswered.map((item) => item.title).join('、')}`
      : failureReason!;
  return agentResultSchema.parse({
    outcome: action === 'complete' ? 'completed' : action === 'request-input' ? 'needs_input' : 'failed',
    summary,
    ...(action === 'complete' ? {
      artifact: {
        title: '开发实现结果',
        content: renderArtifact(current),
      },
      recoveryResolutions: recoveryDeclarations.map((item) => ({
        recoveryId: item.recovery_id,
        summary: item.summary,
        evidence: [item.evidence],
      })),
      tests: checks.map((item) => ({
        command: item.command,
        passed: true,
        summary: item.summary,
      })),
    } : {}),
    runtimeInputs: action === 'request-input'
      ? unanswered.map((item) => ({
        key: item.request_key,
        title: item.title,
        question: item.question,
        why: item.why,
        recommendation: item.recommendation,
      }))
      : [],
  });
}

function terminalSubmit(
  db: Db,
  draft: DevelopmentDraftRow,
  execution: DevelopmentExecutionRow,
  action: 'complete' | 'request-input' | 'fail',
  failureReason?: string,
) {
  assertViewed(draft, execution.execution_id);
  const current = state(db, draft, execution);
  if (action === 'complete') {
    if (current.contract.workflow_phase !== 'finalize') {
      throw new Error(`complete 只能在 finalize 阶段执行；当前阶段是 ${current.contract.workflow_phase}`);
    }
    if (current.contract.validated_change_seq !== draft.change_seq) {
      throw new Error('当前开发草稿版本尚未通过 validate，或验证后又发生了编辑');
    }
  }
  if (action === 'request-input' && current.contract.workflow_phase === 'finalize') {
    throw new Error('FINALIZE 不接受新的运行信息请求；请先重新打开 DEVELOPER VERIFY');
  }
  const errors = validationErrors(current, action);
  if (errors.length) {
    throw new Error(`开发草稿不能执行 ${action}：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  const result = buildResult(current, action, failureReason);
  const status = action === 'request-input' ? 'waiting_for_answers' : 'submitted';
  db.transaction(() => {
    const executionUpdate = db.prepare(`
      UPDATE execution_attempts
      SET result_json = ?, status = 'output_received', heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'running'
    `).run(JSON.stringify(result), execution.execution_id);
    if (executionUpdate.changes !== 1) {
      throw new Error('当前 execution 已不再运行，不能提交终止结果');
    }
    db.prepare(`
      UPDATE agent_work_drafts
      SET status = ?, terminal_action = ?, terminal_execution_id = ?,
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(status, action, execution.execution_id, draft.draft_id);
  })();
  return [
    renderCommandResult({
      command: `implementation ${action}`,
      outcome: action === 'complete'
        ? 'completed'
        : action === 'request-input'
          ? 'waiting_for_human'
          : 'failed',
    }),
    '',
    '# NEXT',
    '',
    '- Owner: Application',
    `- Agent Action: ${action === 'complete' || action === 'fail' ? 'end_execution' : 'wait_for_human'}`,
  ].join('\n');
}

function transitionPhase(input: {
  db: Db;
  draft: DevelopmentDraftRow;
  execution: DevelopmentExecutionRow;
  current: DevelopmentState;
  from: DevelopmentPhase;
  to: DevelopmentPhase;
}) {
  const { db, draft, execution, current, from, to } = input;
  if (current.contract.workflow_phase !== from) {
    throw new Error(`当前阶段是 ${current.contract.workflow_phase}，不能提交 ${from}`);
  }
  const errors = from === 'implement'
    ? implementationErrors(current)
    : from === 'review'
      ? reviewErrors(current)
      : from === 'commit'
        ? []
        : developerVerificationErrors(current);
  if (errors.length) {
    throw new Error(`${from} 阶段不能完成：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE development_drafts
      SET workflow_phase = ?, validated_change_seq = NULL
      WHERE draft_id = ?
    `).run(to, draft.draft_id);
    db.prepare(`
      INSERT INTO development_phase_transitions(
        draft_id, from_phase, to_phase, reason, execution_id
      ) VALUES(?, ?, ?, ?, ?)
    `).run(
      draft.draft_id,
      from,
      to,
      `${from} 阶段产物校验通过`,
      execution.execution_id,
    );
    touchDraft(db, draft.draft_id);
  })();
  const next = state(db, draft, execution);
  return [
    renderCommandResult({
      command: DEVELOPMENT_WORKFLOW[from].submit,
      outcome: 'phase_completed',
      details: [`From: ${from}`, `To: ${to}`],
    }),
    '',
    renderWorkPacket(next, to),
  ].join('\n');
}

function reopenPhase(input: {
  db: Db;
  draft: DevelopmentDraftRow;
  execution: DevelopmentExecutionRow;
  command: string;
  from: DevelopmentPhase;
  to: DevelopmentPhase;
  reason: string;
}) {
  const { db, draft, execution, command, from, to, reason } = input;
  const current = state(db, draft, execution);
  if (current.contract.workflow_phase !== from) {
    throw new Error(`只有 ${from} 阶段可以执行该回流；当前阶段是 ${current.contract.workflow_phase}`);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE development_drafts
      SET workflow_phase = ?, validated_change_seq = NULL,
          review_result = CASE WHEN ? = 'implement' THEN NULL ELSE review_result END,
          review_summary = CASE WHEN ? = 'implement' THEN NULL ELSE review_summary END,
          review_evidence = CASE WHEN ? = 'implement' THEN NULL ELSE review_evidence END
      WHERE draft_id = ?
    `).run(to, to, to, to, draft.draft_id);
    db.prepare(`
      INSERT INTO development_phase_transitions(
        draft_id, from_phase, to_phase, reason, execution_id
      ) VALUES(?, ?, ?, ?, ?)
    `).run(draft.draft_id, from, to, reason, execution.execution_id);
    touchDraft(db, draft.draft_id);
  })();
  const next = state(db, draft, execution);
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

function upsertSimple(
  db: Db,
  table: 'development_risks',
  draftId: string,
  keyColumn: 'risk_key',
  key: string,
  valueColumn: 'content',
  value: string,
) {
  const ordinal = nextOrdinal(db, table, draftId);
  db.prepare(`
    INSERT INTO ${table}(draft_id, ${keyColumn}, ${valueColumn}, ordinal)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(draft_id, ${keyColumn}) DO UPDATE SET ${valueColumn} = excluded.${valueColumn}
  `).run(draftId, key, value, ordinal);
}

const developmentCommandIndex = [
  '  implementation implement complete',
  '  implementation review record --result <pass|needs_changes> --summary <审查结论> --evidence <可定位依据>',
  '  implementation review reopen-implementation --reason <回流原因>',
  '  implementation review complete',
  '  implementation verify reopen-implementation --reason <回流原因>',
  '  implementation verify complete',
  '  implementation commit reopen-verification --reason <回流原因>',
  '  implementation commit complete',
  '  implementation finalize reopen-verification --reason <回流原因>',
  '  implementation criterion satisfy --key <规格 criterion id> --evidence <实现证据>',
  '  implementation check record --key <稳定 key> --receipt <status 中的 receipt> --summary <检查意义与结论>',
  '  implementation validate',
];

export function developmentHelp(terminalActions: string[], topic?: string | null) {
  if (topic === 'evidence') {
    return [
      'Agent 负责说明证据与交付语义的关系，Application 负责确认命令和 Git 事实确实发生。',
      '',
      '验收证据：',
      '  implementation criterion satisfy --key <规格 criterion id> --evidence <可定位实现证据>',
      '  implementation criterion reopen --key <规格 criterion id>',
      '  criterion key 必须逐字复用 status 中列出的规格 key。satisfy 可反复执行以修正证据；只有确实不再满足时才 reopen。',
      '',
      '关键检查（DEVELOPER VERIFY）：',
      '  implementation check record --key <稳定 key> --receipt <status 中的 receipt> --summary <为什么所选检查能支持交付结论>',
      '  implementation check discard --key <稳定 key>',
      '  在确认当前功能完整后，真实执行测试、构建或有意义的检查；随后重新执行 implementation status，从“Application 最近捕获的命令事实”选择明确成功的 receipt。Application 绑定该 receipt 的原始命令哈希；同一命令出现更新结果时必须选择最新结果。Git 历史、分支、HEAD 和未提交文件不使检查失效，也不参与完成校验。不要手抄 command、passed 或 exit code。',
      '',
      '可选披露：',
      '  implementation risk record --key <稳定 key> --content <仍存在但不否定当前交付的风险>',
      '  implementation risk clear --key <稳定 key>',
      '  implementation recovery resolve --id <RECOVERY id> --summary <处理方式> --evidence <证据>',
      '  implementation recovery reopen --id <RECOVERY id>',
      '  recovery 必须复用系统给出的 RECOVERY id；Dev 的处理声明不能关闭恢复事项，仍需 Test Agent 独立验证。',
    ];
  }
  if (topic === 'review') {
    return [
      'REVIEW 是代码质量门禁，发生在实现证据齐备之后、开发者验证之前。它不以测试通过替代代码规范与 Clean Code 审查。',
      '',
      '记录审查：',
      '  implementation review record --result <pass|needs_changes> --summary <规范、可读性、职责边界和维护性结论> --evidence <检查过的文件、diff 或项目规范>',
      '',
      '发现阻塞问题：',
      '  implementation review reopen-implementation --reason <必须修改的原因>',
      '  回流会清除旧审查结论；修正实现后必须重新经过完整 REVIEW。',
      '',
      '审查通过：',
      '  implementation review complete',
      '  只有 result=pass 且摘要与依据完整时才能进入 DEVELOPER VERIFY。',
    ];
  }
  if (topic === 'commit') {
    return [
      'COMMIT 是 DEVELOPER VERIFY 之后的独立提交步骤。Agent 负责执行，Application 只接收阶段完成确认。',
      '',
      '有当前交付单元的代码变化时：',
      '  只暂存属于当前交付单元的文件，按仓库规范执行 Git commit，然后确认：',
      '  implementation commit complete',
      '',
      '没有代码变化时：',
      '  不制造空提交；确认当前交付依赖现有实现后，同样执行 implementation commit complete。',
      '',
      '如果提交前发现实现或开发者验证需要修正：',
      '  implementation commit reopen-verification --reason <回流原因>',
      '',
      'Application 不读取或校验 commit hash、HEAD、提交内容、暂存区、工作区状态，也不要求额外提交字段。阶段完成完全依赖 Agent 的显式确认。',
    ];
  }
  if (topic === 'input') {
    return [
      '运行信息只用于继续实现或开发者验证所必需、无法从上下文与仓库推导、适合由用户补充的非敏感条件。设计审批、业务决策、密钥和可自行调查的事实都不属于运行信息。',
      '',
      '  implementation runtime-input request --key <稳定 key> --title <标题> --question <问题> --why <原因> --recommendation <建议>',
      '  implementation runtime-input withdraw --key <稳定 key>',
      `  ${terminalActions.find((action) => action.endsWith(' request-input')) || 'implementation request-input'}`,
      '',
      '恢复后先 status，逐字复用原 request key 并消费答案。已回答的请求不能 withdraw。',
      '',
      '只有证据确认当前交付在既有契约内无法完成时才终止：',
      `  ${terminalActions.find((action) => action.endsWith(' fail')) || 'implementation fail'} --reason <无法完成的直接原因与证据>`,
      'fail 原子提交原因，不需要预先维护 failure 字段。普通实现取舍、一次命令失败或可修复的测试失败不应终止。',
    ];
  }
  if (topic === 'finish') {
    return [
      '开发实现采用五段调用链；前面阶段完成命令校验对应产物，COMMIT 只记录 Agent 的完成确认，然后返回下一工作包。',
      '',
      '阶段路径：',
      `  ${DEVELOPMENT_PHASE_SEQUENCE}`,
      `  status → ${developmentNormalCommandPath().map((command) => command.replace(/^implementation /, '')).join(' → ')}`,
      '',
      '  implementation validate',
      `  ${terminalActions.find((action) => action.endsWith(' complete')) || 'implementation complete'}`,
      '',
      '完成要求：',
      '  1. 每个规格 key 都有实现证据，并至少选择一条 Runner 已捕获的成功关键检查。',
      '  2. 没有未回答的运行信息。',
      '  3. Agent 已基于当前仓库重新检查功能完整性。',
      '  4. COMMIT 阶段已经由 Agent 显式确认；Application 不校验 Git 历史、分支、HEAD、commit hash、提交内容或工作区状态。',
      '',
      'validate 绑定当前草稿变更版本；验证后任何编辑或回流都会使它失效。',
      '代码审查或开发者验证发现实现问题时必须显式回流 IMPLEMENT，并重新经过 REVIEW。',
      'request-input 与 fail 各按自己的较小门槛原子提交，不要求先通过 validate。普通最终文本、Markdown 或手写 JSON 都不会结束 execution。',
    ];
  }
  if (topic) {
    throw new Error(`开发实现 help 不支持主题：${topic}。可用主题：context、evidence、review、commit、input、finish`);
  }
  return [
    'Dev Agent 把当前交付单元落实为可由 Test Agent 独立验收的仓库状态。',
    'Agent 只提交验收证据关系、关键检查选择和异常信息；Application 记录 Runner 命令事实并确定性生成完成摘要。',
    '',
    `阶段路径：${DEVELOPMENT_PHASE_SEQUENCE}`,
    '当前阶段的命令、readiness 和下一步以 implementation status 返回的工作包为准。',
    '  缺少运行条件：status → runtime-input request → request-input',
    '  有证据确认无法完成：status → fail --reason',
    '',
    '命令索引：',
    ...developmentCommandIndex,
    '  修正、风险、恢复和运行信息属于按需路径，请查看相应主题帮助。',
    '',
    '终止命令：',
    ...terminalActions.map((action) => `  ${action}${action.endsWith(' fail') ? ' --reason <原因与证据>' : ''}`),
    '',
    '主题帮助：',
    '  help context   只读上下文工具与使用时机',
    '  help evidence  验收、关键检查、风险与恢复',
    '  help review    代码规范与 Clean Code 审查门禁',
    '  help commit    Git 提交与无校验完成确认',
    '  help input     运行信息与真实失败',
    '  help finish    完成门槛与终止命令',
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
    return renderStatus(
      { ...draft, status_viewed_execution_id: execution.execution_id },
      state(db, draft, execution),
    );
  }
  if (
    ['implementation complete', 'implementation request-input', 'implementation fail'].includes(command)
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === command.replace('implementation ', '')
  ) {
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
  const current = () => state(db, draft, execution);
  const accepted = (changed: string) => renderContinue(command, changed, current());
  const assertPhase = (...allowed: DevelopmentPhase[]) => {
    const phase = current().contract.workflow_phase;
    if (!allowed.includes(phase)) {
      throw new Error(`命令 ${command} 不属于当前 ${phase} 工作包；允许阶段：${allowed.join('、')}`);
    }
  };

  const phaseCompletion = new Map<string, DevelopmentPhase>([
    [DEVELOPMENT_WORKFLOW.implement.submit, 'implement'],
    [DEVELOPMENT_WORKFLOW.review.submit, 'review'],
    [DEVELOPMENT_WORKFLOW.developer_verify.submit, 'developer_verify'],
    [DEVELOPMENT_WORKFLOW.commit.submit, 'commit'],
  ]);
  const completedPhase = phaseCompletion.get(command);
  if (completedPhase) {
    const phaseIndex = DEVELOPMENT_PHASE_ORDER.indexOf(completedPhase);
    const next = DEVELOPMENT_PHASE_ORDER[phaseIndex + 1];
    if (!next) throw new Error(`${completedPhase} 没有可用的下一阶段`);
    return transitionPhase({
      db,
      draft,
      execution,
      current: current(),
      from: completedPhase,
      to: next,
    });
  }

  const reopenCommands = new Map<string, [DevelopmentPhase, DevelopmentPhase]>([
    ['implementation review reopen-implementation', ['review', 'implement']],
    ['implementation verify reopen-implementation', ['developer_verify', 'implement']],
    ['implementation commit reopen-verification', ['commit', 'developer_verify']],
    ['implementation finalize reopen-verification', ['finalize', 'developer_verify']],
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

  if (command === 'implementation review record') {
    assertPhase('review');
    const result = required(flags, 'result');
    if (!['pass', 'needs_changes'].includes(result)) {
      throw new Error('review result 必须是 pass 或 needs_changes');
    }
    db.prepare(`
      UPDATE development_drafts
      SET review_result = ?, review_summary = ?, review_evidence = ?
      WHERE draft_id = ?
    `).run(
      result,
      bounded(required(flags, 'summary'), '代码审查摘要', 10000),
      bounded(required(flags, 'evidence'), '代码审查依据', 10000),
      draft.draft_id,
    );
    touchDraft(db, draft.draft_id);
    return accepted(`code review recorded_as ${result}`);
  }

  if (command === 'implementation criterion satisfy') {
    assertPhase('implement');
    const key = bounded(required(flags, 'key'), '验收标准 key', 120);
    const current = state(db, draft, execution);
    const allowedKeys = current.expectedCriteria.map((criterion) => criterion.id);
    if (!allowedKeys.includes(key)) {
      throw new Error(
        `验收标准 key ${key} 不属于当前冻结交付规格。`
        + `允许使用的 key：${allowedKeys.length ? allowedKeys.join(', ') : '当前没有可用 key'}`,
      );
    }
    const evidence = bounded(required(flags, 'evidence'), '实现证据');
    const ordinal = nextOrdinal(db, 'development_criteria', draft.draft_id);
    db.prepare(`
      INSERT INTO development_criteria(draft_id, criterion_key, evidence, ordinal)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(draft_id, criterion_key) DO UPDATE SET evidence = excluded.evidence
    `).run(draft.draft_id, key, evidence, ordinal);
    touchDraft(db, draft.draft_id);
    return accepted(`criterion/${key} satisfied`);
  }
  if (command === 'implementation criterion reopen') {
    assertPhase('implement');
    db.prepare('DELETE FROM development_criteria WHERE draft_id = ? AND criterion_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return accepted(`criterion/${required(flags, 'key')} reopened`);
  }
  if (command === 'implementation check record') {
    assertPhase('developer_verify');
    const key = bounded(required(flags, 'key'), '检查 key', 120);
    const commands = capturedCommands(db, execution.execution_id);
    const receiptKey = bounded(required(flags, 'receipt'), 'Runner receipt key', 32);
    const selected = commands.find((item) => item.receiptKey === receiptKey);
    if (!selected) {
      throw new Error(
        `当前 execution 没有可绑定的命令 receipt ${receiptKey}。`
        + '请先执行 implementation status，使用“Application 最近捕获的命令事实”中列出的 receipt',
      );
    }
    if (!selected.commandHash) {
      throw new Error(`Runner receipt ${receiptKey} 缺少原始命令哈希，不能作为可靠检查证据`);
    }
    if (!selected.passed) {
      throw new Error(`所选命令没有明确成功，不能记录为通过检查：${selected.command}`);
    }
    const latestForCommand = commands
      .filter((item) => item.commandHash === selected.commandHash)
      .at(-1);
    if (latestForCommand?.receiptKey !== selected.receiptKey) {
      throw new Error(
        `Runner receipt ${receiptKey} 不是该命令的最新结果；`
        + `请根据 status 选择 ${latestForCommand?.receiptKey || '最新 receipt'}`,
      );
    }
    const ordinal = nextOrdinal(db, 'development_checks', draft.draft_id);
    db.prepare(`
      INSERT INTO development_checks(
        draft_id, check_key, command, command_hash, summary, source_execution_id,
        source_receipt_key, ordinal
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, check_key) DO UPDATE SET
        command = excluded.command, command_hash = excluded.command_hash,
        summary = excluded.summary,
        source_execution_id = excluded.source_execution_id,
        source_receipt_key = excluded.source_receipt_key
    `).run(
      draft.draft_id,
      key,
      selected.command,
      selected.commandHash,
      bounded(required(flags, 'summary'), '检查结论'),
      execution.execution_id,
      selected.receiptKey,
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return accepted(`check/${key} bound_to receipt/${selected.receiptKey}`);
  }
  if (command === 'implementation check discard') {
    assertPhase('developer_verify');
    db.prepare('DELETE FROM development_checks WHERE draft_id = ? AND check_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return accepted(`check/${required(flags, 'key')} discarded`);
  }
  if (command === 'implementation risk record') {
    assertPhase('developer_verify');
    const key = bounded(required(flags, 'key'), '风险 key', 120);
    upsertSimple(
      db,
      'development_risks',
      draft.draft_id,
      'risk_key',
      key,
      'content',
      bounded(required(flags, 'content'), '风险内容'),
    );
    touchDraft(db, draft.draft_id);
    return accepted(`risk/${key} recorded`);
  }
  if (command === 'implementation risk clear') {
    assertPhase('developer_verify');
    db.prepare('DELETE FROM development_risks WHERE draft_id = ? AND risk_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return accepted(`risk/${required(flags, 'key')} cleared`);
  }
  if (command === 'implementation runtime-input request') {
    assertPhase('implement', 'developer_verify');
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
    return accepted(`runtime-input/${key} requested`);
  }
  if (command === 'implementation runtime-input withdraw') {
    assertPhase('implement', 'developer_verify');
    const key = required(flags, 'key');
    const answered = state(db, draft, execution).runtimeInputs
      .find((item) => item.request_key === key)?.answer;
    if (answered) throw new Error(`运行信息 ${key} 已回答，必须保留原 request key 并消费回答`);
    db.prepare('DELETE FROM development_runtime_inputs WHERE draft_id = ? AND request_key = ?')
      .run(draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return accepted(`runtime-input/${key} withdrawn`);
  }
  if (command === 'implementation recovery resolve') {
    assertPhase('implement');
    const id = bounded(required(flags, 'id'), '恢复事项 id', 200);
    const activeRecovery = state(db, draft, execution).activeRecoveries
      .find((item) => item.recovery_id === id);
    if (!activeRecovery) {
      throw new Error(`恢复事项 ${id} 不是当前交付单元的活动恢复事项；请先执行 implementation status 并逐字复用其中的 RECOVERY id`);
    }
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
    return accepted(`recovery/${id} resolved`);
  }
  if (command === 'implementation recovery reopen') {
    assertPhase('implement');
    db.prepare('DELETE FROM development_recovery_resolutions WHERE draft_id = ? AND recovery_id = ?')
      .run(draft.draft_id, required(flags, 'id'));
    touchDraft(db, draft.draft_id);
    return accepted(`recovery/${required(flags, 'id')} reopened`);
  }
  if (command === 'implementation validate') {
    assertPhase('finalize');
    const currentState = current();
    const errors = validationErrors(currentState, 'complete');
    if (errors.length) {
      throw new Error(`开发实现草稿校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }
    db.prepare(`
      UPDATE development_drafts
      SET validated_change_seq = ?
      WHERE draft_id = ?
    `).run(draft.change_seq, draft.draft_id);
    return [
      renderCommandResult({
        command,
        outcome: 'validation_passed',
        details: ['Phase: finalize', 'Readiness: validated'],
      }),
      '',
      '# NEXT',
      '',
      '- Phase: finalize',
      '- Readiness: validated',
      '- Action: `implementation complete`',
    ].join('\n');
  }
  if (command === 'implementation complete') {
    return terminalSubmit(db, draft, execution, 'complete');
  }
  if (command === 'implementation request-input') {
    return terminalSubmit(db, draft, execution, 'request-input');
  }
  if (command === 'implementation fail') {
    const reason = bounded(required(flags, 'reason'), '无法完成的原因与证据');
    return terminalSubmit(db, draft, execution, 'fail', reason);
  }
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}
