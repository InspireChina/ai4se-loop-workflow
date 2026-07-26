import { agentResultSchema, deliverySpecSchema } from '../domain/agent-result';
import {
  gitCommitWithTreeBetween,
  gitChangedFilesBetween,
  gitIsAncestor,
  gitWorkingTreeSnapshot,
} from '../infrastructure/git';
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

export function prepareDevelopmentRepositorySnapshot(
  db: Db,
  draft: DevelopmentDraftRow,
  execution: DevelopmentExecutionRow,
) {
  const header = db.prepare(`
    SELECT repository_base_commit, initial_workspace_fingerprint
    FROM development_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    repository_base_commit: string | null;
    initial_workspace_fingerprint: string | null;
  };
  if (header.initial_workspace_fingerprint !== null && header.repository_base_commit) return;
  const snapshot = gitWorkingTreeSnapshot(paths.root);
  if (!snapshot.readable) {
    throw new Error('Application 无法读取开发周期启动时的 Git 工作区快照');
  }
  db.prepare(`
    UPDATE development_drafts
    SET repository_base_commit = COALESCE(repository_base_commit, ?),
        initial_workspace_fingerprint = COALESCE(initial_workspace_fingerprint, ?),
        initial_workspace_tree = COALESCE(initial_workspace_tree, ?),
        initial_workspace_changes_json = COALESCE(initial_workspace_changes_json, ?)
    WHERE draft_id = ?
  `).run(
    execution.base_commit,
    snapshot.fingerprint,
    snapshot.tree,
    JSON.stringify(snapshot.changes),
    draft.draft_id,
  );
}

function repositoryEvidence(header: {
  repository_base_commit: string | null;
  initial_workspace_fingerprint: string | null;
  initial_workspace_tree: string | null;
  initial_workspace_changes_json: string | null;
}) {
  const originalBase = header.repository_base_commit?.trim() || '';
  const currentWorkspace = gitWorkingTreeSnapshot(paths.root);
  const head = currentWorkspace.head;
  const initialFingerprint = header.initial_workspace_fingerprint ?? '';
  const initialWorkspaceTree = header.initial_workspace_tree || '';
  let initialWorkspaceChanges: string[] = [];
  try {
    initialWorkspaceChanges = JSON.parse(header.initial_workspace_changes_json || '[]') as string[];
  } catch {
    initialWorkspaceChanges = [];
  }
  const baselineIsAncestor = Boolean(
    originalBase && head && gitIsAncestor(paths.root, originalBase, head),
  );
  const materializedBaselineCommit = initialFingerprint && currentWorkspace.fingerprint === ''
    ? gitCommitWithTreeBetween(paths.root, originalBase, head, initialWorkspaceTree)
    : '';
  const base = materializedBaselineCommit || originalBase;
  const changedFiles = base && head && base !== head
    ? gitChangedFilesBetween(paths.root, base, head)
    : [];
  const mode = !base || !head
    ? 'unknown' as const
    : base === head
      ? 'existing' as const
      : 'changed' as const;
  const errors: string[] = [];
  if (!originalBase) errors.push('当前开发周期缺少 Git 基线，Application 无法判断本轮代码事实');
  if (!head) errors.push('当前工作区没有可读取的 Git HEAD');
  if (!currentWorkspace.readable) errors.push('Application 无法读取当前 Git 工作区快照');
  if (originalBase && head && !baselineIsAncestor) {
    errors.push('当前 HEAD 不是 execution Git 基线的后继，不能把换分支或改写历史当作本轮提交');
  }
  const preservedInitialWorkspace = currentWorkspace.fingerprint === initialFingerprint;
  if (!preservedInitialWorkspace && !materializedBaselineCommit) {
    const currentChanges = currentWorkspace.changes.length
      ? `；当前未提交项：${currentWorkspace.changes.slice(0, 20).join(', ')}`
      : '';
    errors.push(
      '工作区未提交状态偏离了开发周期启动快照；已有无关改动必须保持原样，'
      + `若要单独提交它们，提交后的 tree 必须精确等于启动快照${currentChanges}`,
    );
  }
  if (mode === 'changed' && !changedFiles.length) {
    errors.push('Git HEAD 已变化，但基线到当前 HEAD 没有可识别的文件变更');
  }
  return {
    base,
    originalBase,
    head,
    mode,
    changedFiles,
    currentWorkspace,
    initialFingerprint,
    initialWorkspaceTree,
    initialWorkspaceChanges,
    materializedBaselineCommit,
    baselineIsAncestor,
    errors,
  };
}

function state(db: Db, draft: DevelopmentDraftRow, execution: DevelopmentExecutionRow) {
  const header = db.prepare(`
    SELECT repository_base_commit, initial_workspace_fingerprint,
           initial_workspace_tree, initial_workspace_changes_json
    FROM development_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as {
    repository_base_commit: string | null;
    initial_workspace_fingerprint: string | null;
    initial_workspace_tree: string | null;
    initial_workspace_changes_json: string | null;
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
           head_commit, workspace_fingerprint, ordinal
    FROM development_checks WHERE draft_id = ? ORDER BY ordinal, check_key
  `).all(draft.draft_id) as {
    check_key: string;
    command: string;
    command_hash: string;
    summary: string;
    source_execution_id: string;
    source_receipt_key: string;
    head_commit: string;
    workspace_fingerprint: string;
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
    header,
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
    repository: repositoryEvidence(header),
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

function validationErrors(
  current: DevelopmentState,
  terminal: 'complete' | 'request-input' | 'fail' | null = null,
) {
  const errors: string[] = [];
  if (terminal === 'complete' || terminal === null) {
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
    const checks = completionChecks(current);
    if (!checks.length) {
      errors.push(current.activeRecoveries.length
        ? '当前处于恢复修正周期，至少需要在本次 execution 重新执行并记录一条真实成功检查'
        : '至少需要记录一条由 Application 捕获的真实成功检查');
    }
    const staleChecks = checks.filter((item) =>
      item.head_commit !== current.repository.head
      || item.workspace_fingerprint !== current.repository.currentWorkspace.fingerprint);
    if (staleChecks.length) {
      errors.push(`以下关键检查早于最终仓库状态，必须重新执行并记录：${staleChecks.map((item) => item.check_key).join(', ')}`);
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
        `以下关键检查之后又执行了同一命令，必须选择最新结果重新记录：`
        + supersededChecks.map((item) => item.check_key).join(', '),
      );
    }
    const declaredRecoveryIds = new Set(current.recovery.map((item) => item.recovery_id));
    const missingRecoveries = current.activeRecoveries
      .filter((item) => !declaredRecoveryIds.has(item.recovery_id));
    if (missingRecoveries.length) {
      errors.push(`以下活动恢复事项尚未声明处理：${missingRecoveries.map((item) => item.recovery_id).join(', ')}`);
    }
    if (current.runtimeInputs.some((item) => !item.answer)) {
      errors.push('仍有未回答的运行信息请求，不能完成开发');
    }
    errors.push(...current.repository.errors);
  }
  if (terminal === 'request-input') {
    const unanswered = current.runtimeInputs.filter((item) => !item.answer);
    if (!unanswered.length) errors.push('没有待用户补充的运行信息，不能 request-input');
  }
  return [...new Set(errors)];
}

function renderStatus(draft: DevelopmentDraftRow, current: DevelopmentState) {
  const errors = validationErrors(current);
  const checks = completionChecks(current);
  const recoveryDeclarations = activeRecoveryDeclarations(current);
  const repositoryMode = current.repository.mode === 'existing'
    ? 'HEAD 与开发周期基线相同（无需新改动）'
    : current.repository.mode === 'changed'
      ? 'HEAD 已变化（Application 自动识别为本轮有改动）'
      : '暂时无法判断';
  const lines = [
    `开发实现草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    `仓库事实：${repositoryMode}`,
    `开发周期 Git 基线：${current.repository.originalBase ? current.repository.originalBase.slice(0, 12) : '不可读'}`,
    ...(current.repository.materializedBaselineCommit
      ? [`已有工作区改动基线 Commit：${current.repository.materializedBaselineCommit.slice(0, 12)}`]
      : []),
    `当前 HEAD：${current.repository.head ? current.repository.head.slice(0, 12) : '不可读'}`,
    `已提交变更文件：${current.repository.changedFiles.length}`,
    `启动时已有未提交项：${current.repository.initialWorkspaceChanges.length}`,
    `当前未提交项：${current.repository.currentWorkspace.changes.length}`,
    `验收证据：${current.criteria.length}/${current.expectedCriteria.length}`,
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
      `- ${item.check_key}：${item.command} · ${item.summary}（execution=${item.source_execution_id.slice(0, 8)} receipt=${item.source_receipt_key} HEAD=${item.head_commit.slice(0, 10)}）`));
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
  if (errors.length) {
    lines.push('', '完成路径仍需处理：', ...errors.map((item, index) => `${index + 1}. ${item}`));
  } else {
    lines.push('', '完成路径的结构与机器事实校验已通过。');
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
      return `- **${criterion.id}** ${criterion.description}：${coverage ? `已证明 — ${coverage.evidence}` : '未证明'}`;
    }),
    '',
    '## Application 确认的仓库事实',
    '',
    current.repository.mode === 'changed'
      ? `- 本轮从基线 \`${current.repository.base}\` 推进到 Commit \`${current.repository.head}\`。`
      : `- 当前 HEAD \`${current.repository.head}\` 与开发周期基线一致；走查确认现有实现已满足交付承诺。`,
    ...(current.repository.changedFiles.length
      ? current.repository.changedFiles.map((path) => `- \`${path}\``)
      : []),
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
      lines.push(`- **${item.recovery_id}**：${item.summary}（证据：${item.evidence}）`);
    }
  }
  return lines.join('\n');
}

function completionSummary(current: DevelopmentState) {
  const checks = completionChecks(current);
  const repositoryFact = current.repository.mode === 'changed'
    ? `代码已提交至 ${current.repository.head.slice(0, 12)}，变更 ${current.repository.changedFiles.length} 个文件`
    : current.repository.mode === 'existing'
      ? `当前 HEAD ${current.repository.head.slice(0, 12)} 与开发周期基线一致，无需代码变更`
      : '仓库状态不可判定';
  return `开发实现完成：${current.criteria.length}/${current.expectedCriteria.length} 项验收语义已有实现证据，`
    + `${checks.length} 项开发检查通过；${repositoryFact}。`;
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
      changedFiles: current.repository.changedFiles,
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
  const errors = validationErrors(current, action);
  if (errors.length) {
    throw new Error(`开发草稿不能执行 ${action}：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  if (action === 'complete') {
    const confirmation = repositoryEvidence(current.header);
    const repositoryChanged = confirmation.head !== current.repository.head
      || confirmation.currentWorkspace.fingerprint
        !== current.repository.currentWorkspace.fingerprint
      || confirmation.currentWorkspace.tree !== current.repository.currentWorkspace.tree;
    if (confirmation.errors.length || repositoryChanged) {
      throw new Error(
        confirmation.errors.length
          ? `提交前仓库事实复核失败：${confirmation.errors.join('；')}`
          : '校验完成后仓库状态又发生变化，请重新执行 status、必要检查和 validate',
      );
    }
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
  return action === 'complete'
    ? '开发实现结果已提交。'
    : action === 'request-input'
      ? '运行信息请求已提交，等待用户补充。'
      : '开发失败结果已提交。';
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
  '  implementation status',
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
      '关键检查：',
      '  implementation check record --key <稳定 key> --receipt <status 中的 receipt> --summary <为什么所选检查能支持交付结论>',
      '  implementation check discard --key <稳定 key>',
      '  先完成最终代码与提交，再真实执行测试、构建或有意义的检查；随后重新执行 implementation status，从“Application 最近捕获的命令事实”选择明确成功的 receipt。Application 会绑定该 receipt 的原始命令哈希、当前 HEAD 和工作区指纹；HEAD、工作区或同一命令的最新结果变化时必须重跑并重录。不要手抄 command、passed 或 exit code。',
      '',
      '可选披露：',
      '  implementation risk record --key <稳定 key> --content <仍存在但不否定当前交付的风险>',
      '  implementation risk clear --key <稳定 key>',
      '  implementation recovery resolve --id <RECOVERY id> --summary <处理方式> --evidence <证据>',
      '  implementation recovery reopen --id <RECOVERY id>',
      '  recovery 必须复用系统给出的 RECOVERY id；Dev 的处理声明不能关闭恢复事项，仍需 Test Agent 独立验证。',
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
      '完成门槛由 Agent 判断与 Application 机器事实共同组成；validate 与 complete 使用同一套完成校验。',
      '',
      '  implementation validate',
      `  ${terminalActions.find((action) => action.endsWith(' complete')) || 'implementation complete'}`,
      '',
      '完成要求：',
      '  1. 每个规格 key 都有实现证据，并至少选择一条 Runner 已捕获的成功关键检查。',
      '  2. 没有未回答的运行信息。',
      '  3. Application 能读取开发周期 Git 基线与当前 HEAD；启动前已有的无关未提交改动可以保持原样，不能被本轮修改或混入提交。若先把它们独立提交，Application 只在该 Commit 的 tree 精确等于启动快照时自动排除它。',
      '  4. 有效基线后的 HEAD 未变化时自动判为现有实现满足；HEAD 已变化时自动识别 Commit 并生成真实文件清单。Agent 不声明模式，也不重复记账。',
      '',
      '标准路径：status → 调查/必要实现/真实检查 → status 查看 receipt → criterion/check → validate → complete。',
      'request-input 与 fail 各按自己的较小门槛原子提交，不要求先通过 validate。普通最终文本、Markdown 或手写 JSON 都不会结束 execution。',
    ];
  }
  if (topic) {
    throw new Error(`开发实现 help 不支持主题：${topic}。可用主题：context、evidence、input、finish`);
  }
  return [
    'Dev Agent 把当前交付单元落实为可由 Test Agent 独立验收的仓库状态。',
    'Agent 只提交验收证据关系、关键检查选择和异常信息；Application 自动记录 Git、Commit、文件及 Runner 命令事实，并确定性生成完成摘要。',
    '',
    '标准路径：',
    '  status → 调查/必要实现/真实检查 → status 查看 receipt → criterion/check → validate → complete',
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
    '  help input     运行信息与真实失败',
    '  help finish    完成门槛、Git 自动判定与终止命令',
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
    prepareDevelopmentRepositorySnapshot(db, draft, execution);
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
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);

  if (command === 'implementation criterion satisfy') {
    const key = bounded(required(flags, 'key'), '验收标准 key', 120);
    const evidence = bounded(required(flags, 'evidence'), '实现证据');
    const ordinal = nextOrdinal(db, 'development_criteria', draft.draft_id);
    db.prepare(`
      INSERT INTO development_criteria(draft_id, criterion_key, evidence, ordinal)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(draft_id, criterion_key) DO UPDATE SET evidence = excluded.evidence
    `).run(draft.draft_id, key, evidence, ordinal);
    touchDraft(db, draft.draft_id);
    return `验收语义 ${key} 的实现证据已保存。`;
  }
  if (command === 'implementation criterion reopen') {
    db.prepare('DELETE FROM development_criteria WHERE draft_id = ? AND criterion_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '验收语义已重新打开。';
  }
  if (command === 'implementation check record') {
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
    const workspace = gitWorkingTreeSnapshot(paths.root);
    if (!workspace.readable) {
      throw new Error('Application 无法读取当前 Git 工作区快照，不能绑定关键检查');
    }
    const head = workspace.head;
    const ordinal = nextOrdinal(db, 'development_checks', draft.draft_id);
    db.prepare(`
      INSERT INTO development_checks(
        draft_id, check_key, command, command_hash, summary, source_execution_id,
        source_receipt_key, head_commit, workspace_fingerprint, ordinal
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, check_key) DO UPDATE SET
        command = excluded.command, command_hash = excluded.command_hash,
        summary = excluded.summary,
        source_execution_id = excluded.source_execution_id,
        source_receipt_key = excluded.source_receipt_key,
        head_commit = excluded.head_commit,
        workspace_fingerprint = excluded.workspace_fingerprint
    `).run(
      draft.draft_id,
      key,
      selected.command,
      selected.commandHash,
      bounded(required(flags, 'summary'), '检查结论'),
      execution.execution_id,
      selected.receiptKey,
      head,
      workspace.fingerprint,
      ordinal,
    );
    touchDraft(db, draft.draft_id);
    return `关键检查 ${key} 已绑定到 Runner receipt ${selected.receiptKey}。`;
  }
  if (command === 'implementation check discard') {
    db.prepare('DELETE FROM development_checks WHERE draft_id = ? AND check_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '关键检查已取消选择。';
  }
  if (command === 'implementation risk record') {
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
    return `风险 ${key} 已记录。`;
  }
  if (command === 'implementation risk clear') {
    db.prepare('DELETE FROM development_risks WHERE draft_id = ? AND risk_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '风险记录已清除。';
  }
  if (command === 'implementation runtime-input request') {
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
  if (command === 'implementation runtime-input withdraw') {
    const key = required(flags, 'key');
    const answered = state(db, draft, execution).runtimeInputs
      .find((item) => item.request_key === key)?.answer;
    if (answered) throw new Error(`运行信息 ${key} 已回答，必须保留原 request key 并消费回答`);
    db.prepare('DELETE FROM development_runtime_inputs WHERE draft_id = ? AND request_key = ?')
      .run(draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return '运行信息请求已撤回。';
  }
  if (command === 'implementation recovery resolve') {
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
    return `恢复事项 ${id} 的处理声明已保存。`;
  }
  if (command === 'implementation recovery reopen') {
    db.prepare('DELETE FROM development_recovery_resolutions WHERE draft_id = ? AND recovery_id = ?')
      .run(draft.draft_id, required(flags, 'id'));
    touchDraft(db, draft.draft_id);
    return '恢复事项处理声明已重新打开。';
  }
  if (command === 'implementation validate') {
    const errors = validationErrors(state(db, draft, execution), 'complete');
    if (errors.length) {
      throw new Error(`开发实现草稿校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }
    return '开发实现草稿结构与机器事实校验通过。';
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
