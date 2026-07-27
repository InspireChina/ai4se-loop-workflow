import { randomBytes, randomUUID } from 'node:crypto';
import { agentResultSchema, type AgentResult } from '../domain/agent-result';
import {
  agentContextHelpLines,
  agentCommandProfile,
  agentCommandWorkKey,
  loopAgentCommandPrefix,
  type AgentCommandProfile,
} from '../domain/agent-command-profile';
import { databaseConnection, hash } from '../infrastructure/database';
import {
  reproductionHelp,
  runReproductionCommand,
} from './reproduction-command-drafts';
import {
  deliveryAnalysisHelp,
  runDeliveryAnalysisCommand,
} from './delivery-analysis-command-drafts';
import {
  developmentHelp,
  prepareDevelopmentRepositorySnapshot,
  runDevelopmentCommand,
} from './development-command-drafts';
import {
  runVerificationCommand,
  verificationHelp,
} from './verification-command-drafts';
import {
  feedbackHelp,
  runFeedbackCommand,
} from './feedback-command-drafts';
import {
  reviewHelp,
  runReviewCommand,
} from './review-command-drafts';

type ExecutionRow = {
  execution_id: string;
  task_id: string;
  story_index: number | null;
  agent: string;
  pipeline: string;
  delegation_key: string;
  input_json: string;
  status: string;
  command_token_hash: string | null;
  base_commit: string | null;
};

type DraftRow = {
  draft_id: string;
  work_key: string;
  draft_version: number;
  draft_type: 'requirement_context' | 'delivery_plan' | 'reproduction' | 'analysis' | 'development' | 'verification' | 'feedback' | 'review';
  task_id: string;
  story_index: number | null;
  agent: string;
  status: 'editing' | 'waiting_for_answers' | 'submitted' | 'abandoned';
  change_seq: number;
  last_execution_id: string | null;
  status_viewed_execution_id: string | null;
  terminal_execution_id: string | null;
  terminal_action: string | null;
};

type ContextDraft = {
  draft_id: string;
  intent: string | null;
  change_summary: string | null;
  classification: 'feature' | 'bug' | 'tech' | 'other' | null;
};

type ContextAssertion = {
  assertion_key: string;
  perspective: 'actual' | 'expected' | 'target';
  statement: string;
  evidence_status: 'observed' | 'reported' | 'inferred' | 'decided' | 'conflicted';
  source: string;
  decision_key: string | null;
  lifecycle_status: 'active' | 'dismissed' | 'superseded';
  lifecycle_reason: string | null;
  superseded_by: string | null;
};

type ContextImpact = {
  impact_key: string;
  statement: string;
  disposition: 'change' | 'preserve' | 'needs_decision' | 'technical';
  rationale: string;
  source: string;
  decision_key: string | null;
  lifecycle_status: 'active' | 'dismissed' | 'superseded';
  lifecycle_reason: string | null;
  superseded_by: string | null;
};

type ContextAcceptance = {
  acceptance_key: string;
  content: string;
  source: string;
  lifecycle_status: 'active' | 'dismissed' | 'superseded';
  lifecycle_reason: string | null;
  superseded_by: string | null;
};

type DeliveryPlanDraft = {
  draft_id: string;
  rationale: string | null;
  coverage: string | null;
  ordering_notes: string | null;
};

type DeliveryPlanUnit = {
  unit_key: string;
  title: string;
  actor: string;
  trigger_condition: string;
  observable_outcome: string;
  acceptance: string;
  lifecycle_status: 'active' | 'dismissed' | 'superseded';
  lifecycle_reason: string | null;
  superseded_by: string | null;
  ordinal: number;
};

type DeliveryPlanSourceItem = {
  source_key: string;
  source_kind: 'change' | 'preserve' | 'technical' | 'acceptance';
  content: string;
  source_ref: string;
  ordinal: number;
};

type DeliveryPlanSourceLink = {
  unit_key: string;
  source_key: string;
};

type DeliveryPlanDependency = {
  unit_key: string;
  depends_on_unit_key: string;
};

type FlagMap = Map<string, string>;

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

function parseArgs(args: string[]) {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${name} 必须提供值`);
    flags.set(name, next);
    index += 1;
  }
  return { positionals, flags };
}

function executionInDb(db: Awaited<ReturnType<typeof databaseConnection>>, executionId: string) {
  return db.prepare(`
    SELECT execution_id, task_id, story_index, agent, pipeline, delegation_key, input_json,
           status, command_token_hash, base_commit
    FROM execution_attempts WHERE execution_id = ?
  `).get(executionId) as ExecutionRow | undefined;
}

async function authorize(executionId: string, token: string) {
  const db = await databaseConnection();
  const execution = executionInDb(db, executionId);
  if (!execution) throw new Error('当前 execution 不存在');
  if (!execution.command_token_hash || hash(token) !== execution.command_token_hash) {
    throw new Error('当前 execution 的命令凭证无效');
  }
  const profile = agentCommandProfile(execution.agent, execution.pipeline);
  if (!profile) throw new Error(`${execution.agent}/${execution.pipeline} 尚未启用渐进命令`);
  if (!['running', 'output_received'].includes(execution.status)) {
    throw new Error(`当前 execution 状态为 ${execution.status}，不能使用 Agent 命令`);
  }
  let scopeKey: string | undefined;
  try {
    const snapshot = JSON.parse(execution.input_json) as {
      delegation?: {
        feedbackGroupId?: string;
        feedbackBatchId?: string;
        feedbackId?: string;
        reviewRevision?: number;
      };
    };
    scopeKey = execution.agent === 'feedback-agent'
      ? execution.pipeline === 'feedback-triage'
        ? snapshot.delegation?.feedbackBatchId
        : snapshot.delegation?.feedbackId
      : execution.agent === 'review-agent'
        ? execution.pipeline === 'feedback-report'
          ? snapshot.delegation?.feedbackGroupId
          : `v${Number(snapshot.delegation?.reviewRevision || 0) + 1}`
      : snapshot.delegation?.feedbackGroupId;
  } catch {
    // The execution was already validated when persisted; fall back to its delegation key.
  }
  const workKey = agentCommandWorkKey(
    execution.agent,
    execution.pipeline,
    execution.task_id,
    execution.story_index,
    execution.delegation_key,
    scopeKey,
  );
  if (!workKey) throw new Error('当前 execution 没有可用的草稿工作键');
  return { db, execution, profile, workKey };
}

function latestDraft(db: Awaited<ReturnType<typeof databaseConnection>>, workKey: string) {
  return db.prepare(`
    SELECT * FROM agent_work_drafts
    WHERE work_key = ?
    ORDER BY draft_version DESC
    LIMIT 1
  `).get(workKey) as DraftRow | undefined;
}

function cloneRequirementContextDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  db.prepare(`
    INSERT INTO requirement_context_drafts(
      draft_id, intent, change_summary, classification
    )
    SELECT ?, intent, change_summary, classification
    FROM requirement_context_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['requirement_context_constraints', 'constraint_key, content, ordinal'],
    ['requirement_context_scope_items', 'scope_key, direction, content, ordinal'],
    ['requirement_context_questions', 'decision_key, title, question, impact, recommendation_option_id, recommendation_reason, ordinal'],
    [
      'requirement_context_assertions',
      'assertion_key, perspective, statement, evidence_status, source, decision_key, lifecycle_status, lifecycle_reason, superseded_by, ordinal',
    ],
    [
      'requirement_context_impacts',
      'impact_key, statement, disposition, rationale, source, decision_key, lifecycle_status, lifecycle_reason, superseded_by, ordinal',
    ],
    [
      'requirement_context_acceptance_items',
      'acceptance_key, content, source, lifecycle_status, lifecycle_reason, superseded_by, ordinal',
    ],
    [
      'requirement_context_item_revisions',
      'item_type, item_key, action, snapshot_json, execution_id, created_at',
    ],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
  db.prepare(`
    INSERT INTO requirement_context_question_options(
      draft_id, decision_key, option_id, label, consequence, ordinal
    )
    SELECT ?, decision_key, option_id, label, consequence, ordinal
    FROM requirement_context_question_options WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
}

function cloneDeliveryPlanDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  db.prepare(`
    INSERT INTO delivery_plan_drafts(draft_id, rationale, coverage, ordering_notes)
    SELECT ?, rationale, coverage, ordering_notes
    FROM delivery_plan_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  db.prepare(`
    INSERT INTO delivery_plan_units(
      draft_id, unit_key, title, actor, trigger_condition,
      observable_outcome, acceptance, lifecycle_status, lifecycle_reason,
      superseded_by, ordinal
    )
    SELECT ?, unit_key, title, actor, trigger_condition,
           observable_outcome, acceptance, lifecycle_status, lifecycle_reason,
           superseded_by, ordinal
    FROM delivery_plan_units WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['delivery_plan_source_items', 'source_key, source_kind, content, source_ref, ordinal'],
    ['delivery_plan_unit_source_links', 'unit_key, source_key'],
    ['delivery_plan_unit_dependencies', 'unit_key, depends_on_unit_key'],
    ['delivery_plan_unit_revisions', 'unit_key, action, snapshot_json, execution_id, created_at'],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
}

function executionDelegation(execution: ExecutionRow) {
  try {
    return (JSON.parse(execution.input_json) as {
      delegation?: {
        feedbackGroupId?: string;
      };
    }).delegation || {};
  } catch {
    throw new Error('当前 execution 的输入快照无法读取');
  }
}

function initializeDeliveryPlanSources(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  execution: ExecutionRow,
  draft: DraftRow,
) {
  if (execution.pipeline === 'feedback-split') {
    const groupId = executionDelegation(execution).feedbackGroupId;
    if (!groupId) throw new Error('反馈交付规划缺少反馈工作组');
    const group = db.prepare(`
      SELECT group_id, group_key, title, reason, acceptance_json
      FROM feedback_groups
      WHERE group_id = ?
    `).get(groupId) as {
      group_id: string;
      group_key: string;
      title: string | null;
      reason: string;
      acceptance_json: string;
    } | undefined;
    if (!group) throw new Error('反馈交付规划关联的工作组不存在');
    db.prepare(`
      INSERT INTO delivery_plan_source_items(
        draft_id, source_key, source_kind, content, source_ref, ordinal
      ) VALUES(?, ?, 'change', ?, ?, 1)
    `).run(
      draft.draft_id,
      `change:feedback:${group.group_key}`,
      group.title?.trim() ? `${group.title}：${group.reason}` : group.reason,
      `FEEDBACK_GROUP:${group.group_id}`,
    );
    const acceptance = JSON.parse(group.acceptance_json) as unknown;
    if (!Array.isArray(acceptance)) throw new Error('反馈工作组验收要求格式无效');
    for (const [index, item] of acceptance.entries()) {
      if (typeof item !== 'string' || !item.trim()) throw new Error('反馈工作组包含无效验收要求');
      db.prepare(`
        INSERT INTO delivery_plan_source_items(
          draft_id, source_key, source_kind, content, source_ref, ordinal
        ) VALUES(?, ?, 'acceptance', ?, ?, ?)
      `).run(
        draft.draft_id,
        `acceptance:feedback:${group.group_key}:${index + 1}`,
        item.trim(),
        `FEEDBACK_GROUP:${group.group_id}`,
        index + 2,
      );
    }
    return;
  }

  const contextDraft = db.prepare(`
    SELECT work.draft_id
    FROM agent_work_drafts work
    WHERE work.task_id = ?
      AND work.draft_type = 'requirement_context'
      AND work.status = 'submitted'
      AND work.terminal_action = 'complete'
    ORDER BY work.draft_version DESC
    LIMIT 1
  `).get(execution.task_id) as { draft_id: string } | undefined;
  if (!contextDraft) throw new Error('交付规划缺少已完成的业务变化上下文');
  const impacts = db.prepare(`
    SELECT impact_key, statement, disposition
    FROM requirement_context_impacts
    WHERE draft_id = ? AND lifecycle_status = 'active'
    ORDER BY ordinal, impact_key
  `).all(contextDraft.draft_id) as {
    impact_key: string;
    statement: string;
    disposition: 'change' | 'preserve' | 'needs_decision' | 'technical';
  }[];
  const unresolved = impacts.filter((item) => item.disposition === 'needs_decision');
  if (unresolved.length) {
    throw new Error(`业务变化上下文仍有待决影响：${unresolved.map((item) => item.impact_key).join(', ')}`);
  }
  let ordinal = 0;
  for (const impact of impacts) {
    ordinal += 1;
    db.prepare(`
      INSERT INTO delivery_plan_source_items(
        draft_id, source_key, source_kind, content, source_ref, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
    `).run(
      draft.draft_id,
      `impact:${impact.impact_key}`,
      impact.disposition,
      impact.statement,
      `REQUIREMENT_CONTEXT:${contextDraft.draft_id}:impact:${impact.impact_key}`,
      ordinal,
    );
  }
  const acceptance = db.prepare(`
    SELECT acceptance_key, content
    FROM requirement_context_acceptance_items
    WHERE draft_id = ? AND lifecycle_status = 'active'
    ORDER BY ordinal, acceptance_key
  `).all(contextDraft.draft_id) as { acceptance_key: string; content: string }[];
  for (const item of acceptance) {
    ordinal += 1;
    db.prepare(`
      INSERT INTO delivery_plan_source_items(
        draft_id, source_key, source_kind, content, source_ref, ordinal
      ) VALUES(?, ?, 'acceptance', ?, ?, ?)
    `).run(
      draft.draft_id,
      `acceptance:${item.acceptance_key}`,
      item.content,
      `REQUIREMENT_CONTEXT:${contextDraft.draft_id}:acceptance:${item.acceptance_key}`,
      ordinal,
    );
  }
  if (!ordinal) throw new Error('业务变化上下文没有可供交付规划消费的影响或验收语义');
}

function cloneReproductionDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  db.prepare(`
    INSERT INTO reproduction_drafts(
      draft_id, expected_behavior, actual_behavior, environment, stability, impact_scope
    )
    SELECT ?, expected_behavior, actual_behavior, environment, stability, impact_scope
    FROM reproduction_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['reproduction_steps', 'step_key, action, expected, actual, ordinal'],
    ['reproduction_evidence', 'evidence_key, kind, content, source, ordinal'],
    ['reproduction_hypotheses', 'hypothesis_key, statement, status, evidence, ordinal'],
    ['reproduction_questions', 'decision_key, title, question, impact, recommendation_option_id, recommendation_reason, ordinal'],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
  db.prepare(`
    INSERT INTO reproduction_question_options(
      draft_id, decision_key, option_id, label, consequence, ordinal
    )
    SELECT ?, decision_key, option_id, label, consequence, ordinal
    FROM reproduction_question_options WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
}

function initializeDeliveryAnalysisContract(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  execution: ExecutionRow,
  draft: DraftRow,
) {
  if (!execution.story_index) throw new Error('交付分析缺少当前交付单元');
  const unit = db.prepare(`
    SELECT unit_key, title, actor, trigger_condition, observable_outcome, acceptance
    FROM stories
    WHERE task_id = ? AND story_index = ?
  `).get(execution.task_id, execution.story_index) as {
    unit_key: string | null;
    title: string;
    actor: string | null;
    trigger_condition: string | null;
    observable_outcome: string | null;
    acceptance: string | null;
  } | undefined;
  if (!unit) throw new Error(`交付单元不存在：${execution.story_index}`);
  const missing = [
    ['unit key', unit.unit_key],
    ['参与者', unit.actor],
    ['触发条件', unit.trigger_condition],
    ['可观察结果', unit.observable_outcome],
    ['验收语义', unit.acceptance],
  ].filter((entry) => !entry[1]?.trim()).map((entry) => entry[0]);
  if (missing.length) {
    throw new Error(`交付单元契约不完整，不能开始交付分析：缺少${missing.join('、')}`);
  }
  db.prepare(`
    INSERT INTO delivery_analysis_drafts(
      draft_id, unit_key, title, actor, trigger_condition, observable_outcome, acceptance
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(
    draft.draft_id,
    unit.unit_key,
    unit.title,
    unit.actor,
    unit.trigger_condition,
    unit.observable_outcome,
    unit.acceptance,
  );
  const sources = db.prepare(`
    SELECT source_key, source_kind, content, source_ref
    FROM delivery_unit_context_links
    WHERE task_id = ? AND story_index = ?
    ORDER BY source_key
  `).all(execution.task_id, execution.story_index) as {
    source_key: string;
    source_kind: 'change' | 'preserve' | 'technical' | 'acceptance';
    content: string;
    source_ref: string;
  }[];
  if (!sources.length) throw new Error('交付单元没有可追溯的上游来源，不能开始交付分析');
  for (const [index, source] of sources.entries()) {
    db.prepare(`
      INSERT INTO delivery_analysis_source_items(
        draft_id, source_key, source_kind, content, source_ref, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?)
    `).run(
      draft.draft_id,
      source.source_key,
      source.source_kind,
      source.content,
      source.source_ref,
      index + 1,
    );
  }
  const dependencies = db.prepare(`
    SELECT dependency.depends_on_story_index AS story_index,
           upstream.unit_key, upstream.title
    FROM delivery_unit_dependencies dependency
    JOIN stories upstream
      ON upstream.task_id = dependency.task_id
     AND upstream.story_index = dependency.depends_on_story_index
    WHERE dependency.task_id = ? AND dependency.story_index = ?
    ORDER BY dependency.depends_on_story_index
  `).all(execution.task_id, execution.story_index) as {
    story_index: number;
    unit_key: string | null;
    title: string;
  }[];
  for (const [index, dependency] of dependencies.entries()) {
    if (!dependency.unit_key?.trim()) {
      throw new Error(`前置交付单元 ${dependency.story_index} 缺少稳定 unit key`);
    }
    db.prepare(`
      INSERT INTO delivery_analysis_upstream_dependencies(
        draft_id, story_index, unit_key, title, ordinal
      ) VALUES(?, ?, ?, ?, ?)
    `).run(
      draft.draft_id,
      dependency.story_index,
      dependency.unit_key,
      dependency.title,
      index + 1,
    );
  }
}

function cloneDeliveryAnalysisContract(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  db.prepare(`
    INSERT INTO delivery_analysis_drafts(
      draft_id, unit_key, title, actor, trigger_condition, observable_outcome,
      acceptance, summary, implementation_guidance
    )
    SELECT ?, unit_key, title, actor, trigger_condition, observable_outcome,
           acceptance, summary, implementation_guidance
    FROM delivery_analysis_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['delivery_analysis_source_items', 'source_key, source_kind, content, source_ref, ordinal'],
    ['delivery_analysis_upstream_dependencies', 'story_index, unit_key, title, ordinal'],
    ['delivery_analysis_decisions', `decision_key, decision_type, title, question, impact, authority, status,
      selected_option_id, decision_text, rationale, evidence,
      recommendation_option_id, recommendation_reason, ordinal`],
    ['delivery_analysis_impacts', 'impact_key, area, finding, disposition, evidence, decision_key, ordinal'],
    ['delivery_analysis_guardrails', 'guardrail_key, content, rationale, ordinal'],
    ['delivery_analysis_verification_focus', 'focus_key, expected, oracle, ordinal'],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
  db.prepare(`
    INSERT INTO delivery_analysis_decision_options(
      draft_id, decision_key, option_id, label, consequence, ordinal
    )
    SELECT ?, decision_key, option_id, label, consequence, ordinal
    FROM delivery_analysis_decision_options WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
}

function cloneDevelopmentDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  const activeRecovery = Boolean((db.prepare(`
    SELECT 1 AS active
    FROM recovery_items
    WHERE task_id = ? AND story_index IS ?
      AND status IN ('pending', 'claimed', 'reopened')
    LIMIT 1
  `).get(target.task_id, target.story_index) as { active: number } | undefined));
  // A Test-originated correction must establish fresh claims and checks. A
  // waiting-for-answers draft is only a continuation of the same correction,
  // so its progressive judgments remain available after the user responds.
  const startsCorrectionCycle = activeRecovery && source.status !== 'waiting_for_answers';
  db.prepare(`
    INSERT INTO development_drafts(
      draft_id, repository_base_commit,
      initial_workspace_fingerprint, initial_workspace_tree, initial_workspace_changes_json
    )
    SELECT ?, repository_base_commit,
           initial_workspace_fingerprint, initial_workspace_tree, initial_workspace_changes_json
    FROM development_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['development_criteria', 'criterion_key, evidence, ordinal'],
    ['development_risks', 'risk_key, content, ordinal'],
    ['development_runtime_inputs', 'request_key, title, question, why, recommendation, ordinal'],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
  if (!startsCorrectionCycle) {
    for (const table of [
      ['development_checks', `check_key, command, command_hash, summary, source_execution_id,
        source_receipt_key, head_commit, workspace_fingerprint, ordinal`],
      ['development_recovery_resolutions', 'recovery_id, summary, evidence, ordinal'],
    ] as const) {
      db.prepare(`
        INSERT INTO ${table[0]}(draft_id, ${table[1]})
        SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
      `).run(target.draft_id, source.draft_id);
    }
  }
}

function cloneVerificationDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  const sourceHeader = db.prepare(`
    SELECT phase, spec_revision
    FROM verification_drafts WHERE draft_id = ?
  `).get(source.draft_id) as {
    phase: 'planning' | 'executing';
    spec_revision: number | null;
  };
  const currentSpec = db.prepare(`
    SELECT revision
    FROM story_specs
    WHERE task_id = ? AND story_index = ? AND status = 'resolved'
    ORDER BY revision DESC LIMIT 1
  `).get(target.task_id, target.story_index) as { revision: number } | undefined;
  const continuesAfterInput = source.status === 'waiting_for_answers';
  const frozenPlanMatchesCurrentSpec = sourceHeader.phase === 'executing'
    && sourceHeader.spec_revision !== null
    && sourceHeader.spec_revision === currentSpec?.revision;
  const canReuseFrozenPlan = sourceHeader.phase === 'executing'
    && frozenPlanMatchesCurrentSpec;
  const targetPhase = sourceHeader.phase === 'planning'
    ? 'planning'
    : (continuesAfterInput && frozenPlanMatchesCurrentSpec) || canReuseFrozenPlan
      ? 'executing'
      : 'planning';
  const targetSpecRevision = targetPhase === 'executing'
    ? sourceHeader.spec_revision
    : null;
  db.prepare(`
    INSERT INTO verification_drafts(draft_id, phase, spec_revision)
    VALUES(?, ?, ?)
  `).run(target.draft_id, targetPhase, targetSpecRevision);
  for (const table of [
    ['verification_plan_scenarios', `scenario_key, channel, title, setup, steps,
      expected, coverage_refs_json, ordinal`],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
  // Waiting for user-provided runtime information is a continuation of the
  // same Test attempt. The shared runtime_input_requests table owns the
  // request and answer; this draft only restores already executed scenarios.
  if (continuesAfterInput && targetPhase === 'executing') {
    db.prepare(`
      INSERT INTO verification_results(
        draft_id, scenario_key, status, failure_kind, evidence,
        actual_behavior, ordinal
      )
      SELECT ?, scenario_key, status, failure_kind, evidence,
             actual_behavior, ordinal
      FROM verification_results WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
}

function cloneFeedbackDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  db.prepare(`
    INSERT INTO feedback_drafts(draft_id, mode, summary, verification_reason)
    SELECT ?, mode, summary, verification_reason
    FROM feedback_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  db.prepare(`
    INSERT INTO feedback_draft_groups(
      draft_id, group_key, work_type, title, reason, response, ordinal
    )
    SELECT ?, group_key, work_type, title, reason, response, ordinal
    FROM feedback_draft_groups WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['feedback_draft_group_comments', 'group_key, comment_id, ordinal'],
    ['feedback_draft_group_units', 'group_key, story_index, ordinal'],
    ['feedback_draft_acceptance', 'group_key, acceptance_key, content, ordinal'],
    ['feedback_draft_questions', `decision_key, title, question, impact,
      recommendation_option_id, recommendation_reason, ordinal`],
    ['feedback_draft_question_options', 'decision_key, option_id, label, consequence, ordinal'],
    ['feedback_draft_evidence', 'evidence_key, content, ordinal'],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
}

function cloneReviewDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  db.prepare(`
    INSERT INTO review_drafts(
      draft_id, mode, baseline_review_document_id, baseline_review_revision
    )
    SELECT ?, mode, baseline_review_document_id, baseline_review_revision
    FROM review_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['review_required_subjects', `subject_ref, subject_kind, content, source_ref,
      contract_ref, story_index, subject_hash, ordinal`],
    ['review_reconciliations', 'reconciliation_key, subject_ref, result, ordinal'],
    ['review_reconciliation_evidence', `reconciliation_key, evidence_ref,
      evidence_revision, evidence_hash, ordinal`],
    ['review_gaps', `gap_key, subject_ref, gap_kind, reason, boundary, status,
      resolution, forwarded_story_index, ordinal`],
    ['review_sections', 'section_kind, content'],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
}

function createDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  execution: ExecutionRow,
  profile: AgentCommandProfile,
  workKey: string,
  source?: DraftRow,
) {
  return db.transaction(() => {
    const draftId = randomUUID();
    const version = (source?.draft_version || 0) + 1;
    db.prepare(`
      INSERT INTO agent_work_drafts(
        draft_id, work_key, draft_version, draft_type, task_id, story_index,
        agent, status, last_execution_id
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'editing', ?)
    `).run(
      draftId,
      workKey,
      version,
      profile.draftType,
      execution.task_id,
      execution.story_index,
      execution.agent,
      execution.execution_id,
    );
    const created = db.prepare('SELECT * FROM agent_work_drafts WHERE draft_id = ?').get(draftId) as DraftRow;
    if (profile.draftType === 'requirement_context') {
      if (source) cloneRequirementContextDraft(db, source, created);
      else db.prepare('INSERT INTO requirement_context_drafts(draft_id) VALUES(?)').run(draftId);
    } else if (profile.draftType === 'delivery_plan') {
      if (source) cloneDeliveryPlanDraft(db, source, created);
      else {
        db.prepare('INSERT INTO delivery_plan_drafts(draft_id) VALUES(?)').run(draftId);
        initializeDeliveryPlanSources(db, execution, created);
      }
    } else if (profile.draftType === 'reproduction') {
      if (source) cloneReproductionDraft(db, source, created);
      else db.prepare('INSERT INTO reproduction_drafts(draft_id) VALUES(?)').run(draftId);
    } else if (profile.draftType === 'analysis') {
      if (source) {
        cloneDeliveryAnalysisContract(db, source, created);
      } else {
        initializeDeliveryAnalysisContract(db, execution, created);
      }
    } else if (profile.draftType === 'development') {
      if (source) cloneDevelopmentDraft(db, source, created);
      else {
        db.prepare(`
          INSERT INTO development_drafts(draft_id, repository_base_commit)
          VALUES(?, ?)
        `).run(draftId, execution.base_commit);
      }
      db.prepare(`
        UPDATE development_drafts
        SET repository_base_commit = COALESCE(repository_base_commit, ?)
        WHERE draft_id = ?
      `).run(execution.base_commit, draftId);
    } else if (profile.draftType === 'verification') {
      if (source) cloneVerificationDraft(db, source, created);
      else db.prepare('INSERT INTO verification_drafts(draft_id) VALUES(?)').run(draftId);
    } else if (profile.draftType === 'feedback') {
      if (source) cloneFeedbackDraft(db, source, created);
      else {
        db.prepare('INSERT INTO feedback_drafts(draft_id, mode) VALUES(?, ?)')
          .run(draftId, execution.pipeline === 'feedback-triage' ? 'triage' : 'verify');
      }
    } else if (profile.draftType === 'review') {
      if (source) cloneReviewDraft(db, source, created);
      else {
        db.prepare('INSERT INTO review_drafts(draft_id, mode) VALUES(?, ?)')
          .run(
            draftId,
            execution.pipeline === 'feedback-report'
              ? 'report_correction'
              : 'closure',
          );
      }
    }
    return created;
  })();
}

function ensureDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  execution: ExecutionRow,
  profile: AgentCommandProfile,
  workKey: string,
) {
  const ensureDevelopmentBaseline = (draft: DraftRow) => {
    if (profile.draftType === 'development') {
      db.prepare(`
        UPDATE development_drafts
        SET repository_base_commit = COALESCE(repository_base_commit, ?)
        WHERE draft_id = ?
      `).run(execution.base_commit, draft.draft_id);
    }
    return draft;
  };
  const latest = latestDraft(db, workKey);
  if (!latest) return createDraft(db, execution, profile, workKey);
  if (latest.last_execution_id === execution.execution_id) return ensureDevelopmentBaseline(latest);
  if (latest.status === 'editing') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, latest.draft_id);
    return ensureDevelopmentBaseline({ ...latest, last_execution_id: execution.execution_id });
  }
  return createDraft(db, execution, profile, workKey, latest);
}

function assertViewed(draft: DraftRow, executionId: string, namespace = 'requirement-context') {
  if (draft.status_viewed_execution_id !== executionId) {
    throw new Error(`本次启动尚未查看草稿状态。请先执行 ${namespace} status，再继续编辑或提交`);
  }
  if (draft.status !== 'editing') {
    throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
}

function touchDraft(db: Awaited<ReturnType<typeof databaseConnection>>, draftId: string) {
  db.prepare(`
    UPDATE agent_work_drafts
    SET change_seq = change_seq + 1, updated_at = CURRENT_TIMESTAMP
    WHERE draft_id = ?
  `).run(draftId);
}

function nextOrdinal(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  table: string,
  draftId: string,
) {
  return (db.prepare(`
    SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM ${table} WHERE draft_id = ?
  `).get(draftId) as { value: number }).value;
}

function contextDraft(db: Awaited<ReturnType<typeof databaseConnection>>, draftId: string) {
  return db.prepare(`
    SELECT * FROM requirement_context_drafts WHERE draft_id = ?
  `).get(draftId) as ContextDraft;
}

function answeredDecisions(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  taskId: string,
) {
  const rows = db.prepare(`
    SELECT decision_key, title, question, answer
    FROM questions
    WHERE task_id = ? AND source_agent = 'backlog-agent'
      AND decision_key IS NOT NULL AND answer IS NOT NULL
    ORDER BY created_at, question_id
  `).all(taskId) as { decision_key: string; title: string; question: string; answer: string }[];
  return new Map(rows.map((row) => [row.decision_key, row]));
}

function draftState(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  draft: DraftRow,
) {
  const context = contextDraft(db, draft.draft_id);
  const assertions = db.prepare(`
    SELECT assertion_key, perspective, statement, evidence_status, source, decision_key,
           lifecycle_status, lifecycle_reason, superseded_by
    FROM requirement_context_assertions
    WHERE draft_id = ? ORDER BY ordinal, assertion_key
  `).all(draft.draft_id) as ContextAssertion[];
  const impacts = db.prepare(`
    SELECT impact_key, statement, disposition, rationale, source, decision_key,
           lifecycle_status, lifecycle_reason, superseded_by
    FROM requirement_context_impacts
    WHERE draft_id = ? ORDER BY ordinal, impact_key
  `).all(draft.draft_id) as ContextImpact[];
  const acceptance = db.prepare(`
    SELECT acceptance_key, content, source, lifecycle_status, lifecycle_reason, superseded_by
    FROM requirement_context_acceptance_items
    WHERE draft_id = ? ORDER BY ordinal, acceptance_key
  `).all(draft.draft_id) as ContextAcceptance[];
  const revisionCount = (db.prepare(`
    SELECT COUNT(*) AS value
    FROM requirement_context_item_revisions
    WHERE draft_id = ?
  `).get(draft.draft_id) as { value: number }).value;
  const constraints = db.prepare(`
    SELECT constraint_key, content FROM requirement_context_constraints
    WHERE draft_id = ? ORDER BY ordinal, constraint_key
  `).all(draft.draft_id) as { constraint_key: string; content: string }[];
  const scope = db.prepare(`
    SELECT scope_key, direction, content FROM requirement_context_scope_items
    WHERE draft_id = ? ORDER BY ordinal, scope_key
  `).all(draft.draft_id) as { scope_key: string; direction: 'included' | 'excluded'; content: string }[];
  const questions = db.prepare(`
    SELECT decision_key, title, question, impact, recommendation_option_id, recommendation_reason
    FROM requirement_context_questions
    WHERE draft_id = ? ORDER BY ordinal, decision_key
  `).all(draft.draft_id) as {
    decision_key: string;
    title: string;
    question: string;
    impact: string;
    recommendation_option_id: string | null;
    recommendation_reason: string | null;
  }[];
  const options = db.prepare(`
    SELECT decision_key, option_id, label, consequence
    FROM requirement_context_question_options
    WHERE draft_id = ? ORDER BY ordinal, option_id
  `).all(draft.draft_id) as {
    decision_key: string;
    option_id: string;
    label: string;
    consequence: string;
  }[];
  const answers = answeredDecisions(db, draft.task_id);
  return {
    context,
    assertions,
    impacts,
    acceptance,
    revisionCount,
    constraints,
    scope,
    questions: questions.map((question) => ({
      ...question,
      options: options.filter((option) => option.decision_key === question.decision_key),
      answer: answers.get(question.decision_key)?.answer || null,
    })),
  };
}

function validationErrors(
  state: ReturnType<typeof draftState>,
  terminal: 'complete' | 'request-clarification' | null = null,
) {
  const errors: string[] = [];
  const activeAssertions = state.assertions.filter((item) => item.lifecycle_status === 'active');
  const reliableAssertions = activeAssertions.filter((item) =>
    item.evidence_status !== 'inferred' && item.evidence_status !== 'conflicted');
  const activeImpacts = state.impacts.filter((item) => item.lifecycle_status === 'active');
  const activeAcceptance = state.acceptance.filter((item) => item.lifecycle_status === 'active');
  if (!state.context.intent?.trim()) {
    errors.push('缺少业务意图：使用 requirement-context intent set --text <内容>');
  }
  if (terminal === 'request-clarification') {
    if (!activeAssertions.length) {
      errors.push('请求澄清前至少需要记录一条带来源的业务语义陈述');
    }
  } else {
    for (const perspective of ['actual', 'expected', 'target'] as const) {
      if (!reliableAssertions.some((item) => item.perspective === perspective)) {
        const label = perspective === 'actual'
          ? 'AS-IS Actual'
          : perspective === 'expected'
            ? 'AS-IS Expected'
            : 'TO-BE';
        errors.push(`缺少可靠的 ${label} 陈述：使用 requirement-context assertion upsert`);
      }
    }
    if (!state.context.change_summary?.trim()) {
      errors.push('缺少业务变化摘要：使用 requirement-context change set --text <内容>');
    }
    if (!activeImpacts.length) {
      errors.push('至少需要一条有效业务影响：使用 requirement-context impact upsert');
    }
    if (!activeAcceptance.length) {
      errors.push('至少需要一条需求级验收语义：使用 requirement-context acceptance upsert');
    }
  }
  if (terminal === 'complete' && !state.context.classification) {
    errors.push('缺少需求分类：使用 requirement-context classification set <feature|bug|tech|other>');
  }
  for (const question of state.questions) {
    if (question.answer) continue;
    if (question.options.length < 2) errors.push(`问题 ${question.decision_key} 至少需要两个互斥选项`);
    if (!question.recommendation_option_id) errors.push(`问题 ${question.decision_key} 缺少推荐选项`);
    else if (!question.options.some((option) => option.option_id === question.recommendation_option_id)) {
      errors.push(`问题 ${question.decision_key} 的推荐选项不存在`);
    }
    if (!question.recommendation_reason?.trim()) errors.push(`问题 ${question.decision_key} 缺少推荐理由`);
  }
  const unanswered = state.questions.filter((question) => !question.answer);
  for (const assertion of activeAssertions.filter((item) => item.evidence_status === 'conflicted')) {
    if (!assertion.decision_key) {
      errors.push(`冲突陈述 ${assertion.assertion_key} 缺少关联 decision key`);
    } else if (!state.questions.some((question) => question.decision_key === assertion.decision_key)) {
      errors.push(`冲突陈述 ${assertion.assertion_key} 关联的问题 ${assertion.decision_key} 不存在`);
    }
  }
  for (const impact of activeImpacts.filter((item) => item.disposition === 'needs_decision')) {
    if (!impact.decision_key) {
      errors.push(`待决影响 ${impact.impact_key} 缺少关联 decision key`);
    } else if (!state.questions.some((question) => question.decision_key === impact.decision_key)) {
      errors.push(`待决影响 ${impact.impact_key} 关联的问题 ${impact.decision_key} 不存在`);
    }
  }
  if (terminal === 'complete' && unanswered.length) {
    errors.push(`仍有 ${unanswered.length} 个未回答问题，不能完成需求上下文`);
  }
  if (terminal === 'complete' && activeAssertions.some((item) => item.evidence_status === 'conflicted')) {
    errors.push('仍有未解决的证据冲突，不能完成需求上下文');
  }
  if (terminal === 'complete' && activeImpacts.some((item) => item.disposition === 'needs_decision')) {
    errors.push('仍有未收敛的待决业务影响，必须根据用户回答更新其处理结论');
  }
  if (terminal === 'request-clarification' && !unanswered.length) {
    errors.push('没有待用户回答的问题，不能请求澄清');
  }
  return errors;
}

function renderStatus(draft: DraftRow, state: ReturnType<typeof draftState>) {
  const missing = validationErrors(state);
  const activeAssertions = state.assertions.filter((item) => item.lifecycle_status === 'active');
  const activeImpacts = state.impacts.filter((item) => item.lifecycle_status === 'active');
  const activeAcceptance = state.acceptance.filter((item) => item.lifecycle_status === 'active');
  const lines = [
    `需求上下文草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    `业务意图：${state.context.intent || '未填写'}`,
    `变化摘要：${state.context.change_summary || '未填写'}`,
    `分类：${state.context.classification || '未填写'}`,
    '',
    `业务语义：Actual ${activeAssertions.filter((item) => item.perspective === 'actual').length}`
      + ` / Expected ${activeAssertions.filter((item) => item.perspective === 'expected').length}`
      + ` / TO-BE ${activeAssertions.filter((item) => item.perspective === 'target').length}`,
    `业务影响：${activeImpacts.length}（历史 ${state.impacts.length - activeImpacts.length}）`,
    `验收语义：${activeAcceptance.length}`,
    `语义修订记录：${state.revisionCount}`,
    `约束：${state.constraints.length}`,
    `范围：包含 ${state.scope.filter((item) => item.direction === 'included').length} / 排除 ${state.scope.filter((item) => item.direction === 'excluded').length}`,
    `问题：${state.questions.length}（已回答 ${state.questions.filter((item) => item.answer).length}）`,
  ];
  if (state.assertions.length) {
    lines.push('', '业务语义索引（跨轮次复用稳定 key）：');
    for (const assertion of state.assertions) {
      lines.push(
        `- ${assertion.assertion_key} · ${assertion.perspective}`
        + ` · ${assertion.evidence_status} · ${assertion.lifecycle_status}：${assertion.statement}`
        + `（来源：${assertion.source}）`
        + (assertion.decision_key ? ` · decision=${assertion.decision_key}` : '')
        + (assertion.lifecycle_reason ? ` · 原因：${assertion.lifecycle_reason}` : ''),
      );
    }
  }
  if (state.impacts.length) {
    lines.push('', '业务影响索引（识别影响不等于自动纳入范围）：');
    for (const impact of state.impacts) {
      lines.push(
        `- ${impact.impact_key} · ${impact.disposition} · ${impact.lifecycle_status}：${impact.statement}`
        + `（依据：${impact.rationale}；来源：${impact.source}）`
        + (impact.decision_key ? ` · decision=${impact.decision_key}` : '')
        + (impact.lifecycle_reason ? ` · 原因：${impact.lifecycle_reason}` : ''),
      );
    }
  }
  if (state.acceptance.length) {
    lines.push('', '验收语义索引：');
    for (const acceptance of state.acceptance) {
      lines.push(
        `- ${acceptance.acceptance_key} · ${acceptance.lifecycle_status}：${acceptance.content}`
        + `（来源：${acceptance.source}）`
        + (acceptance.lifecycle_reason ? ` · 原因：${acceptance.lifecycle_reason}` : ''),
      );
    }
  }
  if (state.constraints.length) {
    lines.push('', '约束索引（编辑时复用 key）：');
    for (const constraint of state.constraints) {
      lines.push(`- ${constraint.constraint_key}：${constraint.content}`);
    }
  }
  if (state.scope.length) {
    lines.push('', '范围索引（编辑时复用 key）：');
    for (const item of state.scope) {
      lines.push(`- ${item.scope_key} · ${item.direction === 'included' ? '包含' : '排除'}：${item.content}`);
    }
  }
  if (state.questions.length) {
    lines.push('', '问题索引（decision key 跨轮次不可改名）：');
    for (const question of state.questions) {
      const options = question.options.map((option) =>
        `${option.option_id}=${option.label}${option.option_id === question.recommendation_option_id ? '（推荐）' : ''}`,
      ).join('；');
      lines.push(
        `- ${question.decision_key}：${question.title} · ${question.answer ? `已回答：${question.answer}` : '待回答'}`
        + (options ? ` · 选项：${options}` : ''),
      );
    }
  }
  if (missing.length) {
    lines.push('', '当前校验提示：', ...missing.map((item, index) => `${index + 1}. ${item}`));
  } else if (!state.context.classification) {
    lines.push(
      '',
      '草稿基础结构完整，但 complete 前仍需确定需求分类。',
      state.questions.some((question) => !question.answer)
        ? '若分类取决于待回答问题，可以先提交 request-clarification；不要猜测临时分类。'
        : '当前没有待回答问题，请设置 classification 后再 complete。',
    );
  } else {
    lines.push('', '草稿结构完整。请根据是否仍有未回答问题选择终止命令。');
  }
  return lines.join('\n');
}

function renderArtifact(state: ReturnType<typeof draftState>) {
  const included = state.scope.filter((item) => item.direction === 'included');
  const excluded = state.scope.filter((item) => item.direction === 'excluded');
  const assertionSection = (
    perspective: ContextAssertion['perspective'],
    fallback: string,
  ) => {
    const assertions = state.assertions.filter((item) =>
      item.perspective === perspective && item.lifecycle_status === 'active');
    return assertions.length
      ? assertions.map((item) => `- ${item.statement}`)
      : [`- ${fallback}`];
  };
  const impactSection = (disposition: ContextImpact['disposition'], fallback: string) => {
    const impacts = state.impacts.filter((item) =>
      item.disposition === disposition && item.lifecycle_status === 'active');
    return impacts.length
      ? impacts.map((item) => `- ${item.statement}`)
      : [`- ${fallback}`];
  };
  const lines = [
    '# 业务变化上下文',
    '',
    '## 需求类型',
    '',
    state.context.classification || '待确认',
    '',
    '## 业务意图',
    '',
    state.context.intent || '',
    '',
    '## AS-IS Actual',
    '',
    ...assertionSection('actual', '尚未形成可靠结论'),
    '',
    '## AS-IS Expected',
    '',
    ...assertionSection('expected', '尚未形成可靠结论'),
    '',
    '## TO-BE',
    '',
    ...assertionSection('target', '尚未形成可靠结论'),
    '',
    '## 业务变化',
    '',
    state.context.change_summary || '尚未形成完整变化摘要',
    '',
    '## 业务影响',
    '',
    '### 必须同步改变',
    '',
    ...impactSection('change', '暂无已确认项'),
    '',
    '### 必须保持不变',
    '',
    ...impactSection('preserve', '暂无已确认项'),
    '',
    '### 待业务决策',
    '',
    ...impactSection('needs_decision', '暂无待决项'),
    '',
    '### 交给后续技术分析',
    '',
    ...impactSection('technical', '暂无已识别项'),
    '',
    '## 需求级验收语义',
    '',
    ...(
      state.acceptance.filter((item) => item.lifecycle_status === 'active').length
        ? state.acceptance
          .filter((item) => item.lifecycle_status === 'active')
          .map((item) => `- ${item.content}`)
        : ['- 尚未明确']
    ),
    '',
    '## 约束',
    '',
    ...(state.constraints.length ? state.constraints.map((item) => `- ${item.content}`) : ['- 暂无明确约束']),
    '',
    '## 范围边界',
    '',
    '### 包含',
    '',
    ...(included.length ? included.map((item) => `- ${item.content}`) : ['- 尚未明确']),
    '',
    '### 不包含',
    '',
    ...(excluded.length ? excluded.map((item) => `- ${item.content}`) : ['- 尚未明确']),
  ];
  const answered = state.questions.filter((question) => question.answer);
  if (answered.length) {
    lines.push('', '## 用户确认决策', '');
    for (const question of answered) lines.push(`- **${question.title}**：${question.answer}`);
  }
  const unanswered = state.questions.filter((question) => !question.answer);
  if (unanswered.length) {
    lines.push('', '## 待确认边界', '');
    for (const question of unanswered) lines.push(`- **${question.title}**：${question.question}`);
  }
  return lines.join('\n');
}

function buildResult(
  state: ReturnType<typeof draftState>,
  action: 'complete' | 'request-clarification',
) {
  const questions = state.questions.filter((question) => !question.answer).map((question) => {
    const recommended = question.options.find((option) => option.option_id === question.recommendation_option_id)!;
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
  const complete = action === 'complete';
  return agentResultSchema.parse({
    outcome: complete ? 'completed' : 'needs_input',
    summary: complete
      ? `业务变化上下文已完成：${state.context.intent}`
      : `业务变化上下文存在 ${questions.length} 个需要用户确认的边界`,
    artifact: {
      title: '业务变化上下文',
      content: renderArtifact(state),
    },
    questions,
    ...(complete ? {
      classification: state.context.classification,
      route: state.context.classification === 'bug' ? 'repro' : 'plan',
    } : {}),
  });
}

function terminalSubmit(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  draft: DraftRow,
  execution: ExecutionRow,
  action: 'complete' | 'request-clarification',
) {
  assertViewed(draft, execution.execution_id);
  const state = draftState(db, draft);
  const errors = validationErrors(state, action);
  if (errors.length) {
    throw new Error(`草稿不能执行 ${action}：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  const result = buildResult(state, action);
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
    ? '业务变化上下文已提交成功。普通最终回复不再用于推进流程，可以结束本轮。'
    : '需求澄清请求已提交成功。普通最终回复不再用于推进流程，可以结束本轮。';
}

function deliveryPlanState(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  draft: DraftRow,
) {
  const plan = db.prepare(`
    SELECT draft_id, rationale, coverage, ordering_notes
    FROM delivery_plan_drafts WHERE draft_id = ?
  `).get(draft.draft_id) as DeliveryPlanDraft;
  const units = db.prepare(`
    SELECT unit_key, title, actor, trigger_condition, observable_outcome, acceptance,
           lifecycle_status, lifecycle_reason, superseded_by, ordinal
    FROM delivery_plan_units
    WHERE draft_id = ?
    ORDER BY ordinal, unit_key
  `).all(draft.draft_id) as DeliveryPlanUnit[];
  const sources = db.prepare(`
    SELECT source_key, source_kind, content, source_ref, ordinal
    FROM delivery_plan_source_items
    WHERE draft_id = ?
    ORDER BY ordinal, source_key
  `).all(draft.draft_id) as DeliveryPlanSourceItem[];
  const sourceLinks = db.prepare(`
    SELECT unit_key, source_key
    FROM delivery_plan_unit_source_links
    WHERE draft_id = ?
    ORDER BY unit_key, source_key
  `).all(draft.draft_id) as DeliveryPlanSourceLink[];
  const dependencies = db.prepare(`
    SELECT unit_key, depends_on_unit_key
    FROM delivery_plan_unit_dependencies
    WHERE draft_id = ?
    ORDER BY unit_key, depends_on_unit_key
  `).all(draft.draft_id) as DeliveryPlanDependency[];
  const revisionCount = (db.prepare(`
    SELECT COUNT(*) AS value
    FROM delivery_plan_unit_revisions
    WHERE draft_id = ?
  `).get(draft.draft_id) as { value: number }).value;
  const existingUnits = db.prepare(`
    SELECT story_index, unit_key, title
    FROM stories
    WHERE task_id = ?
    ORDER BY story_index
  `).all(draft.task_id) as { story_index: number; unit_key: string | null; title: string }[];
  return { plan, units, sources, sourceLinks, dependencies, revisionCount, existingUnits };
}

function deliveryPlanValidationErrors(state: ReturnType<typeof deliveryPlanState>) {
  const errors: string[] = [];
  const activeUnits = state.units.filter((unit) => unit.lifecycle_status === 'active');
  const activeKeys = new Set(activeUnits.map((unit) => unit.unit_key));
  const existingKeys = new Set(state.existingUnits
    .map((unit) => unit.unit_key)
    .filter((key): key is string => Boolean(key)));
  if (!state.plan.rationale?.trim()) {
    errors.push('缺少拆分依据：使用 delivery-plan rationale set --text <内容>');
  }
  if (!state.plan.coverage?.trim()) {
    errors.push('缺少整体覆盖说明：使用 delivery-plan coverage set --text <内容>');
  }
  if (!state.sources.length) {
    errors.push('交付计划缺少冻结的上游规划输入，不能完成');
  }
  if (!activeUnits.length) {
    errors.push('至少需要一个可独立交付的交付单元');
  }
  if (activeUnits.length > 50) {
    errors.push('单次交付计划最多包含 50 个有效交付单元');
  }
  if (activeUnits.length > 1 && !state.plan.ordering_notes?.trim()) {
    errors.push('存在多个交付单元时必须说明推荐顺序与依赖依据');
  }

  const duplicateTitles = activeUnits
    .filter((unit, index) =>
      activeUnits.findIndex((candidate) => candidate.title.trim() === unit.title.trim()) !== index)
    .map((unit) => unit.title.trim());
  if (duplicateTitles.length) {
    errors.push(`有效交付单元不能使用重复标题：${[...new Set(duplicateTitles)].join('、')}`);
  }
  const conflictingKeys = activeUnits
    .map((unit) => unit.unit_key)
    .filter((key) => existingKeys.has(key));
  if (conflictingKeys.length) {
    errors.push(`交付单元 key 已被当前需求中的既有单元使用：${conflictingKeys.join(', ')}`);
  }

  for (const unit of activeUnits) {
    const linkedSourceKeys = state.sourceLinks
      .filter((link) => link.unit_key === unit.unit_key)
      .map((link) => link.source_key);
    const linkedSources = state.sources.filter((source) => linkedSourceKeys.includes(source.source_key));
    if (!linkedSources.length) {
      errors.push(`交付单元 ${unit.unit_key} 未关联任何规划输入`);
    } else if (linkedSources.length > 200) {
      errors.push(`交付单元 ${unit.unit_key} 最多关联 200 个规划输入`);
    } else if (!linkedSources.some((source) =>
      source.source_kind === 'change' || source.source_kind === 'acceptance')) {
      errors.push(`交付单元 ${unit.unit_key} 只关联了保持项或技术后果，尚未形成业务变化或验收闭环`);
    }
    const dependencies = state.dependencies.filter((item) => item.unit_key === unit.unit_key);
    if (dependencies.length > 50) {
      errors.push(`交付单元 ${unit.unit_key} 最多声明 50 个前置单元`);
    }
    for (const dependency of dependencies) {
      if (!activeKeys.has(dependency.depends_on_unit_key)) {
        errors.push(`交付单元 ${unit.unit_key} 依赖的 ${dependency.depends_on_unit_key} 不是有效交付单元`);
        continue;
      }
      const requiredUnit = activeUnits.find((item) => item.unit_key === dependency.depends_on_unit_key)!;
      if (requiredUnit.ordinal >= unit.ordinal) {
        errors.push(`交付单元 ${unit.unit_key} 的前置 ${requiredUnit.unit_key} 必须排在它之前`);
      }
    }
  }

  for (const source of state.sources) {
    const coveredBy = state.sourceLinks
      .filter((link) => link.source_key === source.source_key && activeKeys.has(link.unit_key))
      .map((link) => link.unit_key);
    if (!coveredBy.length) {
      const label = source.source_kind === 'change'
        ? '必须同步改变'
        : source.source_kind === 'preserve'
          ? '必须保持'
          : source.source_kind === 'technical'
            ? '技术后果'
            : '验收语义';
      errors.push(`${label} ${source.source_key} 尚未由任何有效交付单元承接`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dependenciesByUnit = new Map(activeUnits.map((unit) => [
    unit.unit_key,
    state.dependencies
      .filter((item) => item.unit_key === unit.unit_key && activeKeys.has(item.depends_on_unit_key))
      .map((item) => item.depends_on_unit_key),
  ]));
  const visit = (unitKey: string): boolean => {
    if (visiting.has(unitKey)) return true;
    if (visited.has(unitKey)) return false;
    visiting.add(unitKey);
    for (const dependency of dependenciesByUnit.get(unitKey) || []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(unitKey);
    visited.add(unitKey);
    return false;
  };
  if (activeUnits.some((unit) => visit(unit.unit_key))) {
    errors.push('交付单元依赖存在循环，无法形成可执行顺序');
  }
  return errors;
}

function renderDeliveryPlanStatus(
  draft: DraftRow,
  state: ReturnType<typeof deliveryPlanState>,
) {
  const errors = deliveryPlanValidationErrors(state);
  const lines = [
    `交付计划草稿 v${draft.draft_version} · 变更 ${draft.change_seq}`,
    '',
    `拆分依据：${state.plan.rationale || '未填写'}`,
    `整体覆盖：${state.plan.coverage || '未填写'}`,
    `排序说明：${state.plan.ordering_notes || '未填写'}`,
    `规划输入：${state.sources.length}`,
    `交付单元：${state.units.filter((unit) => unit.lifecycle_status === 'active').length}`
      + `（历史 ${state.units.filter((unit) => unit.lifecycle_status !== 'active').length}）`,
    `单元修订记录：${state.revisionCount}`,
  ];
  if (state.sources.length) {
    lines.push('', '规划输入索引（交付单元必须引用稳定 source key）：');
    for (const source of state.sources) {
      lines.push(`- ${source.source_key} · ${source.source_kind}：${source.content}（来源：${source.source_ref}）`);
    }
  }
  if (state.existingUnits.length) {
    lines.push('', '当前需求已有交付单元（新增计划的 unit key 不得重复）：');
    for (const unit of state.existingUnits) {
      lines.push(`- ${unit.story_index}. ${unit.unit_key || '无稳定 key'}：${unit.title}`);
    }
  }
  if (state.units.length) {
    lines.push('', '交付单元索引（跨轮次编辑必须复用 unit key）：');
    for (const [index, unit] of state.units.entries()) {
      const sourceKeys = state.sourceLinks
        .filter((link) => link.unit_key === unit.unit_key)
        .map((link) => link.source_key);
      const dependencies = state.dependencies
        .filter((item) => item.unit_key === unit.unit_key)
        .map((item) => item.depends_on_unit_key);
      lines.push(
        `${index + 1}. ${unit.unit_key} · ${unit.lifecycle_status}：${unit.title}`,
        `   参与者：${unit.actor}`,
        `   触发条件：${unit.trigger_condition}`,
        `   可观察结果：${unit.observable_outcome}`,
        `   验收标准：${unit.acceptance}`,
        `   覆盖来源：${sourceKeys.length ? sourceKeys.join(', ') : '未关联'}`,
        `   前置单元：${dependencies.length ? dependencies.join(', ') : '无'}`,
        ...(unit.lifecycle_reason ? [`   修订原因：${unit.lifecycle_reason}`] : []),
      );
    }
  }
  if (errors.length) {
    lines.push('', '当前校验提示：', ...errors.map((item, index) => `${index + 1}. ${item}`));
  } else {
    lines.push('', '交付计划草稿结构完整，可以校验并提交。');
  }
  return lines.join('\n');
}

function renderDeliveryPlanArtifact(state: ReturnType<typeof deliveryPlanState>) {
  const activeUnits = state.units.filter((unit) => unit.lifecycle_status === 'active');
  const lines = [
    '# 交付计划',
    '',
    '## 拆分依据',
    '',
    state.plan.rationale || '',
    '',
    '## 整体覆盖',
    '',
    state.plan.coverage || '',
  ];
  if (state.plan.ordering_notes?.trim()) {
    lines.push('', '## 排序与依赖', '', state.plan.ordering_notes);
  }
  lines.push('', '## 交付单元', '');
  for (const [index, unit] of activeUnits.entries()) {
    const linkedSources = state.sourceLinks
      .filter((link) => link.unit_key === unit.unit_key)
      .map((link) => state.sources.find((source) => source.source_key === link.source_key))
      .filter((source): source is DeliveryPlanSourceItem => Boolean(source));
    const dependencies = state.dependencies
      .filter((item) => item.unit_key === unit.unit_key)
      .map((item) => item.depends_on_unit_key);
    lines.push(
      `### ${index + 1}. ${unit.title}`,
      '',
      `- 稳定标识：\`${unit.unit_key}\``,
      `- 参与者：${unit.actor}`,
      `- 触发条件：${unit.trigger_condition}`,
      `- 用户可观察结果：${unit.observable_outcome}`,
      `- 验收标准：${unit.acceptance}`,
      `- 前置单元：${dependencies.length ? dependencies.map((key) => `\`${key}\``).join('、') : '无'}`,
      '- 承接的规划输入：',
      ...linkedSources.map((source) =>
        `  - \`${source.source_key}\` · ${source.source_kind}：${source.content}`),
      '',
    );
  }
  const historicalUnits = state.units.filter((unit) => unit.lifecycle_status !== 'active');
  if (historicalUnits.length) {
    lines.push('', '## 已修正的候选单元', '');
    for (const unit of historicalUnits) {
      lines.push(
        `- \`${unit.unit_key}\`：${unit.lifecycle_status}；${unit.lifecycle_reason || '未记录原因'}`
        + `${unit.superseded_by ? `；由 \`${unit.superseded_by}\` 取代` : ''}`,
      );
    }
  }
  return lines.join('\n').trim();
}

function buildDeliveryPlanResult(state: ReturnType<typeof deliveryPlanState>) {
  const activeUnits = state.units.filter((unit) => unit.lifecycle_status === 'active');
  return agentResultSchema.parse({
    outcome: 'completed',
    summary: `已规划 ${activeUnits.length} 个可独立交付的交付单元`,
    artifact: {
      title: '交付计划',
      content: renderDeliveryPlanArtifact(state),
    },
    deliveryUnits: activeUnits.map((unit) => {
      const sourceKeys = state.sourceLinks
        .filter((link) => link.unit_key === unit.unit_key)
        .map((link) => link.source_key);
      return {
        key: unit.unit_key,
        title: unit.title,
        actor: unit.actor,
        trigger: unit.trigger_condition,
        observableOutcome: unit.observable_outcome,
        acceptance: unit.acceptance,
        sourceRefs: state.sources
          .filter((source) => sourceKeys.includes(source.source_key))
          .map((source) => ({
            key: source.source_key,
            kind: source.source_kind,
            content: source.content,
            sourceRef: source.source_ref,
          })),
        dependsOn: state.dependencies
          .filter((item) => item.unit_key === unit.unit_key)
          .map((item) => item.depends_on_unit_key),
      };
    }),
  });
}

function submitDeliveryPlan(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  draft: DraftRow,
  execution: ExecutionRow,
) {
  assertViewed(draft, execution.execution_id, 'delivery-plan');
  const state = deliveryPlanState(db, draft);
  const errors = deliveryPlanValidationErrors(state);
  if (errors.length) {
    throw new Error(`交付计划不能完成：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
  }
  const result = buildDeliveryPlanResult(state);
  db.transaction(() => {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status = 'submitted', terminal_action = 'complete', terminal_execution_id = ?,
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, draft.draft_id);
    db.prepare(`
      UPDATE execution_attempts
      SET status = 'output_received', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'running'
    `).run(JSON.stringify(result), execution.execution_id);
  })();
  return '交付计划已提交成功。普通最终回复不再用于推进流程，可以结束本轮。';
}

const requirementContextCommandIndex = [
  '  requirement-context intent set --text <业务意图>',
  '  requirement-context change set --text <Actual、Expected 与 TO-BE 的变化摘要>',
  '  requirement-context assertion upsert --key <key> --perspective <actual|expected|target> --statement <陈述> --evidence <observed|reported|inferred|decided|conflicted> --source <来源> [--decision <问题key>]',
  '  requirement-context assertion dismiss --key <key> --reason <理由>',
  '  requirement-context assertion supersede --key <旧key> --by <新key> --reason <理由>',
  '  requirement-context impact upsert --key <key> --statement <影响> --disposition <change|preserve|needs_decision|technical> --rationale <依据> --source <来源> [--decision <问题key>]',
  '  requirement-context impact dismiss --key <key> --reason <理由>',
  '  requirement-context impact supersede --key <旧key> --by <新key> --reason <理由>',
  '  requirement-context acceptance upsert --key <key> --text <验收语义> --source <来源>',
  '  requirement-context acceptance dismiss --key <key> --reason <理由>',
  '  requirement-context acceptance supersede --key <旧key> --by <新key> --reason <理由>',
  '  requirement-context classification set <feature|bug|tech|other>',
  '  requirement-context constraint add --key <key> --text <内容>',
  '  requirement-context constraint remove --key <key>',
  '  requirement-context scope include|exclude --key <key> --text <内容>',
  '  requirement-context scope remove --key <key>',
  '  requirement-context question add --key <key> --title <标题> --question <问题> --impact <影响>',
  '  requirement-context question option-add --key <问题key> --id <选项id> --label <名称> --consequence <后果>',
  '  requirement-context question recommend --key <问题key> --option <选项id> --reason <理由>',
  '  requirement-context question remove --key <key>',
  '  requirement-context validate',
];

function requirementContextHelp(terminalActions: string[], topic?: string | null) {
  if (topic === 'assertion') {
    return [
      '业务语义陈述用于区分当前实际发生的 Actual、当前本来要求的 Expected 和本次完成后的 Target。',
      '',
      '  requirement-context intent set --text <业务意图>',
      '  requirement-context change set --text <Actual、Expected 与 TO-BE 的变化摘要>',
      '  requirement-context assertion upsert --key <稳定key> --perspective <actual|expected|target> --statement <陈述> --evidence <observed|reported|inferred|decided|conflicted> --source <来源> [--decision <问题key>]',
      '',
      'perspective：',
      '  actual    当前真实发生或存在的业务行为。',
      '  expected  当前业务原本应满足的语义，用于区分 Bug 与主动变化。',
      '  target    本次交付完成后希望成立的业务语义。',
      '',
      'evidence：',
      '  observed    通过运行、数据或可重复检查直接观察。',
      '  reported    用户或可靠上游明确陈述，但尚未独立观察。',
      '  inferred    根据现有证据推断；不能单独作为完成时的可靠 Actual、Expected 或 Target。',
      '  decided     用户或权威上游已经明确决定。',
      '  conflicted  证据相互冲突，必须关联待回答的 decision key 后请求澄清。',
      '',
      '完成需求上下文时，Actual、Expected、Target 各至少需要一条非 inferred、非 conflicted 的可靠陈述。',
      '',
      '修订：',
      '  requirement-context assertion dismiss --key <key> --reason <理由>',
      '  requirement-context assertion supersede --key <旧key> --by <新key> --reason <理由>',
      '  同一语义的补充或纠正复用原 key；错误候选用 dismiss。使用 supersede 前，必须先创建同类型、不同 key 的 active 新结论。',
      '',
      '需求级验收语义：',
      '  requirement-context acceptance upsert --key <稳定key> --text <验收语义> --source <来源>',
      '  requirement-context acceptance dismiss --key <key> --reason <理由>',
      '  requirement-context acceptance supersede --key <旧key> --by <新key> --reason <理由>',
      '  正常完成时至少需要一条 active 验收语义；supersede 同样要求先创建同类型、不同 key 的 active 新条目。',
    ];
  }
  if (topic === 'impact') {
    return [
      '业务影响记录目标变化会波及的业务语义；识别影响不等于自动扩大本轮范围。',
      '',
      '  requirement-context impact upsert --key <稳定key> --statement <影响> --disposition <change|preserve|needs_decision|technical> --rationale <依据> --source <来源> [--decision <问题key>]',
      '',
      'disposition：',
      '  change          为使目标业务语义成立，本轮必须同步改变。',
      '  preserve        与本次变化相关，但必须维持原有业务行为。',
      '  needs_decision  是否改变属于新的业务选择，必须关联待回答的 decision key。',
      '  technical       已识别的技术后果，不在需求梳理阶段决定，由后续交付分析承接。',
      '',
      '  requirement-context impact dismiss --key <key> --reason <理由>',
      '  requirement-context impact supersede --key <旧key> --by <新key> --reason <理由>',
      '  同一影响的补充或纠正复用原 key；无效影响用 dismiss。使用 supersede 前，必须先创建不同 key 的 active 新影响。',
    ];
  }
  if (topic === 'question') {
    return [
      '只有无法从现有上下文和证据推导、并且会实质改变业务目标、规则、参与者、范围、分类或验收结果的问题才提交给用户。',
      '',
      '提问路径：',
      '  question add → 至少两次 option-add → question recommend → validate → request-clarification',
      '',
      '  requirement-context question add --key <稳定decision key> --title <标题> --question <问题> --impact <不同回答的业务影响>',
      '  requirement-context question option-add --key <问题key> --id <选项id> --label <名称> --consequence <后果>',
      '  requirement-context question recommend --key <问题key> --option <推荐选项id> --reason <推荐理由>',
      '  requirement-context question remove --key <key>',
      '',
      '每个未回答问题至少需要两个真实互斥选项、一个推荐选项和推荐理由。question remove 只用于尚未提交给用户的错误候选。',
      '若问题源于 conflicted assertion 或 needs_decision impact，必须用同一 decision key 关联；普通问题本身不要求 assertion 或 impact 反向引用。',
      '',
      '恢复轮：',
      '  先执行 status，逐字复用原 decision key 和用户答案；将关联的 conflicted assertion 更新为可靠结论，将 needs_decision impact 更新为 change、preserve 或 technical，再完成其余上下文。不得换 key 或重复询问。',
    ];
  }
  if (topic === 'scope') {
    return [
      '约束与范围是按当前需求确有必要时才填写的可选边界，不应为了表单完整制造条目。',
      '',
      '约束：',
      '  requirement-context constraint add --key <稳定key> --text <必须遵守的业务或交付约束>',
      '  requirement-context constraint remove --key <key>',
      '',
      '范围：',
      '  requirement-context scope include --key <稳定key> --text <明确属于本轮的业务范围>',
      '  requirement-context scope exclude --key <稳定key> --text <明确不属于本轮的业务范围>',
      '  requirement-context scope remove --key <key>',
      '',
      '分类：',
      '  requirement-context classification set <feature|bug|tech|other>',
      '  feature  主动改变业务能力或业务语义。',
      '  bug      Actual 偏离已有明确 Expected。',
      '  tech     主要改变工程属性并保持业务语义。',
      '  other    确实不属于前三类的有效需求。',
      '  分类只表达需求类型；bug 由 Application 路由到问题复现，其余类型路由到交付规划。',
    ];
  }
  if (topic === 'finish') {
    return [
      '校验不会推进流程；可以反复执行并根据错误继续修改草稿。',
      '',
      '  requirement-context validate',
      '',
      '正常完成路径：',
      '  status → intent → Actual/Expected/Target assertions → change → impacts → acceptance → classification → validate → complete',
      `  ${terminalActions.find((action) => action.endsWith(' complete')) || 'requirement-context complete'}`,
      '  必填：业务意图、可靠的 Actual/Expected/Target、变化摘要、至少一条有效影响、至少一条需求级验收语义和需求分类。',
      '  可选：约束、显式范围和问题；只有业务上真实存在时才创建。',
      '',
      '澄清路径：',
      '  完成必要调查并记录至少一条带来源陈述 → 建立有效问题与选项 → validate → request-clarification',
      `  ${terminalActions.find((action) => action.endsWith(' request-clarification')) || 'requirement-context request-clarification'}`,
      '  澄清最低必填：业务意图、至少一条 active 且带来源的业务语义陈述，以及至少一个结构完整的未回答问题。',
      '  澄清阶段不要求猜测尚未确定的完整 Target 或需求分类；用户回答后由新的 resume execution 在原 key 上继续。',
      '',
      'validate 的含义：',
      '  存在未回答问题时，validate 自动按 request-clarification 的最低结构校验。',
      '  没有未回答问题时，validate 检查完整上下文结构，但仍不校验 classification；只有 complete 执行包含分类在内的最终完成校验。',
      '',
      '普通最终文本、Markdown 或手写 JSON 都不会结束 execution。',
    ];
  }
  if (topic) {
    throw new Error(`需求上下文 help 不支持主题：${topic}。可用主题：context、assertion、impact、question、scope、finish`);
  }
  return [
    '完成需求上下文必须建立可靠的 Actual、Expected、Target，说明业务变化及影响，并形成需求级验收语义和分类。',
    '约束、显式范围和问题是可选项；只有真实存在时才创建。',
    '',
    '标准路径：',
    '  正常完成：status → intent/assertions/change/impacts/acceptance/classification → validate → complete',
    '  用户澄清：question + options + recommendation；若源于冲突或待决影响则关联同一 decision key → validate → request-clarification',
    '  恢复处理：status → 复用原 decision key 消费回答 → 更新关联语义与影响 → complete',
    '',
    '命令索引：',
    ...requirementContextCommandIndex,
    '',
    '终止命令：',
    ...terminalActions.map((action) => `  ${action}`),
    '',
    '主题帮助：',
    '  help context    只读上下文工具与使用时机',
    '  help assertion  Actual、Expected、Target、证据状态和验收语义',
    '  help impact     业务影响与 disposition 含义',
    '  help question   用户澄清与恢复路径',
    '  help scope      约束、范围与分类',
    '  help finish     必填项、校验与终止命令',
  ];
}

const deliveryPlanCommandIndex = [
  '  delivery-plan rationale set --text <拆分依据>',
  '  delivery-plan coverage set --text <整体覆盖说明>',
  '  delivery-plan ordering set --text <排序与依赖说明>',
  '  delivery-plan unit upsert --key <稳定key> --title <标题> --actor <参与者> --trigger <触发条件> --outcome <可观察结果> --acceptance <验收标准>',
  '  delivery-plan unit dismiss --key <稳定key> --reason <理由>',
  '  delivery-plan unit supersede --key <旧key> --by <新key> --reason <理由>',
  '  delivery-plan unit move --key <稳定key> --position <从1开始的位置>',
  '  delivery-plan unit source add --key <单元key> --source <规划输入key>',
  '  delivery-plan unit source remove --key <单元key> --source <规划输入key>',
  '  delivery-plan unit dependency add --key <单元key> --on <前置单元key>',
  '  delivery-plan unit dependency remove --key <单元key> --on <前置单元key>',
  '  delivery-plan validate',
];

function deliveryPlanHelp(terminalActions: string[], topic?: string | null) {
  if (topic === 'unit') {
    return [
      '交付单元必须是参与者在明确触发下获得可观察结果、并能独立验收的最小业务闭环；不能按数据库、API、页面或测试等技术层拆分。',
      '',
      '  delivery-plan unit upsert --key <稳定key> --title <标题> --actor <参与者> --trigger <触发条件> --outcome <可观察结果> --acceptance <验收标准>',
      '  delivery-plan unit move --key <稳定key> --position <从1开始的位置>',
      '',
      '每个单元都必须填写参与者、触发条件、可观察结果和独立验收语义。一个简单需求可以只有一个单元；拆开后形成半成品时应合并，包含多个独立业务结果时应继续拆分。',
      '每个有效单元必须关联至少一项真实规划输入，并且至少承接一项 change 或 acceptance。',
      '一个计划允许 1 至 50 个有效单元；有效单元标题不能重复，unit key 不能与当前需求中已有的历史交付单元冲突。',
    ];
  }
  if (topic === 'source') {
    return [
      '规划输入由 Application 在草稿创建时冻结。Agent 不能创建或改写来源，只能把每项关联到真正承接它的交付单元。',
      '',
      '  delivery-plan unit source add --key <单元key> --source <规划输入key>',
      '  delivery-plan unit source remove --key <单元key> --source <规划输入key>',
      '',
      'source kind：',
      '  change      必须由一个或多个单元实现的业务变化。',
      '  preserve    相关单元必须继承的不变约束，通常不单独形成交付单元。',
      '  technical   需要传给后续交付分析的技术后果，通常不单独形成交付单元。',
      '  acceptance  所有单元组合后必须覆盖的需求级验收语义。',
      '',
      '所有冻结输入都必须被至少一个有效单元承接；同一输入可以关联多个确实相关的单元，但不能为了通过校验建立虚假关联。',
      'dismiss 或 supersede 不会自动迁移来源关联；旧单元失活后，其关联不再计入覆盖，新单元必须重新建立真实来源关联。',
    ];
  }
  if (topic === 'dependency') {
    return [
      '依赖只表示业务上真实存在的前置关系；并行可交付的单元不能为了执行顺序被强行串联。',
      '',
      '  delivery-plan ordering set --text <推荐顺序与依赖依据>',
      '  delivery-plan unit dependency add --key <单元key> --on <前置单元key>',
      '  delivery-plan unit dependency remove --key <单元key> --on <前置单元key>',
      '  delivery-plan unit move --key <单元key> --position <从1开始的位置>',
      '',
      '依赖两端必须是当前草稿中的 active 单元；status 中列出的既有历史单元不能作为 --on。依赖不能指向自身、不能成环，每个单元最多声明 50 个前置单元。',
      'unit move 只调整顺序，不会创建依赖；dependency add 只建立依赖，也不会自动移动单元。前置单元必须显式排在依赖它的单元之前。',
      '只有一个有效单元时 ordering 可省略；存在多个有效单元时必须填写排序与依赖说明，即使它们之间没有前置依赖。',
    ];
  }
  if (topic === 'revision') {
    return [
      'unit key 是跨 attempt 的稳定业务身份。补充或纠正同一个业务闭环时使用相同 key 执行 upsert，禁止换 key 堆叠同义单元。',
      '',
      '  delivery-plan unit dismiss --key <稳定key> --reason <理由>',
      '  delivery-plan unit supersede --key <旧key> --by <新key> --reason <理由>',
      '',
      'dismiss 用于调查后确认不是有效交付单元的错误候选；supersede 用于旧单元确实被另一个不同稳定身份的新单元取代。',
      '已 dismissed 或 superseded 的 key 保留为历史，不能重新激活；新增计划的 key 也不能与当前需求已有交付单元重复。',
      '修订不会自动迁移来源、顺序或依赖。替换时先创建 active 新单元并补齐来源；在旧单元仍 active 时移除或改接引用它的依赖；最后再 supersede 旧单元。',
    ];
  }
  if (topic === 'finish') {
    return [
      '校验不会推进流程；可以反复执行并根据覆盖、顺序或引用错误继续修改。',
      '',
      '  delivery-plan validate',
      '',
      '正常路径：',
      '  status → rationale/coverage → unit upsert → source add → 必要的 ordering/dependency/move → validate → complete',
      `  ${terminalActions.find((action) => action.endsWith(' complete')) || 'delivery-plan complete'}`,
      '',
      '完成要求：',
      '  必填拆分依据、整体覆盖说明、全部冻结规划输入的真实承接关系，以及 1 至 50 个有效交付单元。',
      '  每个单元必须形成独立业务闭环、关联至少一个来源，并至少承接 change 或 acceptance。',
      '  多单元计划必须说明推荐顺序；依赖必须无环并与顺序一致。',
      '  排序说明和依赖在单单元计划中可省略；交付规划 Agent 不向用户提问。',
      '  validate 与 complete 使用同一套结构校验；validate 只反馈问题且不终止，complete 是唯一会提交计划并结束 execution 的命令。',
      '',
      '普通最终文本、Markdown 或手写 JSON 都不会结束 execution。',
    ];
  }
  if (topic) {
    throw new Error(`交付计划 help 不支持主题：${topic}。可用主题：context、unit、source、dependency、revision、finish`);
  }
  return [
    '完成交付计划必须说明拆分依据与整体覆盖，并用有序、可独立验收的业务闭环承接全部冻结规划输入。',
    '排序说明只在多单元时必填；依赖只在业务上真实存在时创建。',
    '',
    '标准路径：',
    '  status → rationale/coverage → unit upsert → source add → 必要的 ordering/dependency/move → validate → complete',
    '  错误候选：unit dismiss；被不同新单元取代：unit supersede；同一语义修正：原 key upsert',
    '',
    '命令索引：',
    ...deliveryPlanCommandIndex,
    '',
    '终止命令：',
    ...terminalActions.map((action) => `  ${action}`),
    '',
    '主题帮助：',
    '  help context     只读上下文工具与使用时机',
    '  help unit        交付单元的业务闭环语义',
    '  help source      冻结规划输入与承接关系',
    '  help dependency  排序、前置依赖与移动',
    '  help revision    稳定 key、dismiss 与 supersede',
    '  help finish      必填项、校验与完成',
  ];
}

function helpText(execution: ExecutionRow, profile: AgentCommandProfile, topic?: string | null) {
  const appRoot = process.env.LOOP_APP_ROOT?.trim() || '<Loop App Root>';
  const command = loopAgentCommandPrefix(appRoot);
  if (topic === 'context') {
    return [
      `当前身份：${execution.agent} · ${execution.pipeline}`,
      '',
      '只读上下文工具：',
      '这些命令只读取当前 execution 创建时冻结的 Context Snapshot，不修改需求、草稿或流程状态。',
      ...agentContextHelpLines(appRoot),
      '',
      '使用顺序：',
      '  1. 先执行当前角色的 status，恢复草稿和稳定 key。',
      '  2. Prompt 已给出 required refs 时优先使用 get。',
      '  3. 不知道 ref 或怀疑资料未展示时使用 search/list。',
      '  4. 核对前序执行时使用 evidence；仅在版本或替代冲突时使用 history。',
      execution.agent === 'review-agent'
        ? '  5. Review 只消费已有最终仓库执行记录和独立 Test 证据，不重新运行测试或修改仓库。'
        : '  5. 再使用仓库文件、Git 和测试工具确认实时 Ground Truth。',
      execution.agent === 'review-agent'
        ? '  6. 已有证据无法闭合时声明结卡缺口，不创建问题或运行信息请求。'
        : '  6. 完成上述调查后仍无法唯一确定，才声明缺少信息或提交问题。',
    ].join('\n');
  }
  if (topic) {
    if (profile.draftType === 'requirement_context') {
      return [
        `当前身份：${execution.agent} · ${execution.pipeline}`,
        `帮助主题：${topic}`,
        '',
        ...requirementContextHelp(profile.terminalActions, topic),
        '',
        '长文本参数：',
        '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件。',
        `  返回完整索引：${command} help`,
      ].join('\n');
    }
    if (profile.draftType === 'delivery_plan') {
      return [
        `当前身份：${execution.agent} · ${execution.pipeline}`,
        `帮助主题：${topic}`,
        '',
        ...deliveryPlanHelp(profile.terminalActions, topic),
        '',
        '长文本参数：',
        '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件。',
        `  返回完整索引：${command} help`,
      ].join('\n');
    }
    if (profile.draftType === 'analysis') {
      return [
        `当前身份：${execution.agent} · ${execution.pipeline}`,
        `帮助主题：${topic}`,
        '',
        ...deliveryAnalysisHelp(profile.terminalActions, topic),
        '',
        '长文本参数：',
        '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件。',
        `  返回完整索引：${command} help`,
      ].join('\n');
    }
    if (profile.draftType === 'development') {
      return [
        `当前身份：${execution.agent} · ${execution.pipeline}`,
        `帮助主题：${topic}`,
        '',
        ...developmentHelp(profile.terminalActions, topic),
        '',
        '长文本参数：',
        '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件。',
        `  返回完整索引：${command} help`,
      ].join('\n');
    }
    if (profile.draftType === 'verification') {
      return [
        `当前身份：${execution.agent} · ${execution.pipeline}`,
        `帮助主题：${topic}`,
        '',
        ...verificationHelp(profile.terminalActions, topic),
        '',
        '长文本参数：',
        '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件。',
        `  返回完整索引：${command} help`,
      ].join('\n');
    }
    if (profile.draftType === 'review') {
      return [
        `当前身份：${execution.agent} · ${execution.pipeline}`,
        `帮助主题：${topic}`,
        '',
        ...reviewHelp(profile.terminalActions, topic),
        '',
        '长文本参数：',
        '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件。',
        `  返回完整索引：${command} help`,
      ].join('\n');
    }
    throw new Error(`当前角色 help 不支持主题：${topic}。可用主题：context`);
  }
  const common = [
    `当前身份：${execution.agent} · ${execution.pipeline}`,
    '',
    '公共诊断命令：',
    `  ${command} help`,
    `  ${command} whoami`,
    '',
    '只读上下文工具：',
    '这些命令只读取当前 execution 创建时冻结的 Context Snapshot，不修改需求、草稿或流程状态。',
    ...agentContextHelpLines(appRoot),
    '',
    '每次启动必须先执行：',
    `  ${profile.namespace} status`,
    '',
    '草稿命令：',
  ];
  if (profile.draftType === 'delivery_plan') {
    return [
      ...common,
      ...deliveryPlanHelp(profile.terminalActions, null),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  if (profile.draftType === 'reproduction') {
    return [
      ...common,
      ...reproductionHelp(profile.terminalActions),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  if (profile.draftType === 'analysis') {
    return [
      ...common,
      ...deliveryAnalysisHelp(profile.terminalActions, null),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  if (profile.draftType === 'development') {
    return [
      ...common,
      ...developmentHelp(profile.terminalActions, null),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  if (profile.draftType === 'verification') {
    return [
      ...common,
      ...verificationHelp(profile.terminalActions, null),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  if (profile.draftType === 'feedback') {
    return [
      ...common,
      ...feedbackHelp(profile.terminalActions),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  if (profile.draftType === 'review') {
    return [
      ...common,
      ...reviewHelp(profile.terminalActions, null),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  return [
    ...common,
    ...requirementContextHelp(profile.terminalActions, null),
    '',
    '长文本参数：',
    '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
  ].join('\n');
}

function runDeliveryPlanCommand(input: {
  db: Awaited<ReturnType<typeof databaseConnection>>;
  execution: ExecutionRow;
  draft: DraftRow;
  command: string;
  flags: FlagMap;
}) {
  const { db, execution, command, flags } = input;
  let { draft } = input;
  if (command === 'delivery-plan status') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    draft = { ...draft, status_viewed_execution_id: execution.execution_id };
    return renderDeliveryPlanStatus(draft, deliveryPlanState(db, draft));
  }
  if (
    command === 'delivery-plan complete'
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === 'complete'
  ) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id, 'delivery-plan');

  if (
    command === 'delivery-plan rationale set'
    || command === 'delivery-plan coverage set'
    || command === 'delivery-plan ordering set'
  ) {
    const field = command.split(' ')[1];
    const column = field === 'rationale'
      ? 'rationale'
      : field === 'coverage'
        ? 'coverage'
        : 'ordering_notes';
    const label = field === 'rationale' ? '拆分依据' : field === 'coverage' ? '整体覆盖说明' : '排序说明';
    db.prepare(`UPDATE delivery_plan_drafts SET ${column} = ? WHERE draft_id = ?`)
      .run(bounded(required(flags, 'text'), label), draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `${label}已保存。`;
  }
  if (command === 'delivery-plan unit upsert') {
    const key = bounded(required(flags, 'key'), '交付单元 key', 120);
    const existing = db.prepare(`
      SELECT lifecycle_status FROM delivery_plan_units
      WHERE draft_id = ? AND unit_key = ?
    `).get(draft.draft_id, key) as { lifecycle_status: string } | undefined;
    if (existing && existing.lifecycle_status !== 'active') {
      throw new Error(`交付单元 ${key} 已是 ${existing.lifecycle_status}，请使用新的稳定 key 记录新单元`);
    }
    const ordinal = nextOrdinal(db, 'delivery_plan_units', draft.draft_id);
    db.prepare(`
      INSERT INTO delivery_plan_units(
        draft_id, unit_key, title, actor, trigger_condition,
        observable_outcome, acceptance, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, unit_key) DO UPDATE SET
        title = excluded.title,
        actor = excluded.actor,
        trigger_condition = excluded.trigger_condition,
        observable_outcome = excluded.observable_outcome,
        acceptance = excluded.acceptance
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'title'), '交付单元标题', 200),
      bounded(required(flags, 'actor'), '参与者', 500),
      bounded(required(flags, 'trigger'), '触发条件'),
      bounded(required(flags, 'outcome'), '可观察结果'),
      bounded(required(flags, 'acceptance'), '验收标准'),
      ordinal,
    );
    recordDeliveryPlanUnitRevision(db, {
      draftId: draft.draft_id,
      executionId: execution.execution_id,
      unitKey: key,
      action: 'upsert',
    });
    touchDraft(db, draft.draft_id);
    return `交付单元 ${key} 已保存。`;
  }
  if (
    command === 'delivery-plan unit dismiss'
    || command === 'delivery-plan unit supersede'
  ) {
    const key = bounded(required(flags, 'key'), '交付单元 key', 120);
    const superseded = command.endsWith('supersede');
    reviseDeliveryPlanUnitLifecycle(db, {
      draftId: draft.draft_id,
      unitKey: key,
      lifecycle: superseded ? 'superseded' : 'dismissed',
      reason: bounded(required(flags, 'reason'), '修订理由'),
      supersededBy: superseded ? bounded(required(flags, 'by'), '取代单元 key', 120) : undefined,
    });
    recordDeliveryPlanUnitRevision(db, {
      draftId: draft.draft_id,
      executionId: execution.execution_id,
      unitKey: key,
      action: superseded ? 'supersede' : 'dismiss',
    });
    touchDraft(db, draft.draft_id);
    return `交付单元 ${key} 已标记为${superseded ? '已取代' : '已排除'}。`;
  }
  if (
    command === 'delivery-plan unit source add'
    || command === 'delivery-plan unit source remove'
  ) {
    const key = bounded(required(flags, 'key'), '交付单元 key', 120);
    const sourceKey = bounded(required(flags, 'source'), '规划输入 key', 240);
    requireActiveDeliveryPlanUnit(db, draft.draft_id, key);
    const source = db.prepare(`
      SELECT 1 FROM delivery_plan_source_items
      WHERE draft_id = ? AND source_key = ?
    `).get(draft.draft_id, sourceKey);
    if (!source) throw new Error(`规划输入 ${sourceKey} 不存在`);
    if (command.endsWith('add')) {
      db.prepare(`
        INSERT INTO delivery_plan_unit_source_links(draft_id, unit_key, source_key)
        VALUES(?, ?, ?)
        ON CONFLICT(draft_id, unit_key, source_key) DO NOTHING
      `).run(draft.draft_id, key, sourceKey);
    } else {
      const removed = db.prepare(`
        DELETE FROM delivery_plan_unit_source_links
        WHERE draft_id = ? AND unit_key = ? AND source_key = ?
      `).run(draft.draft_id, key, sourceKey);
      if (!removed.changes) throw new Error(`交付单元 ${key} 未关联规划输入 ${sourceKey}`);
    }
    touchDraft(db, draft.draft_id);
    return `交付单元 ${key} 与规划输入 ${sourceKey} 的关联已${command.endsWith('add') ? '保存' : '移除'}。`;
  }
  if (
    command === 'delivery-plan unit dependency add'
    || command === 'delivery-plan unit dependency remove'
  ) {
    const key = bounded(required(flags, 'key'), '交付单元 key', 120);
    const dependsOn = bounded(required(flags, 'on'), '前置单元 key', 120);
    if (key === dependsOn) throw new Error('交付单元不能依赖自身');
    requireActiveDeliveryPlanUnit(db, draft.draft_id, key);
    requireActiveDeliveryPlanUnit(db, draft.draft_id, dependsOn);
    if (command.endsWith('add')) {
      db.prepare(`
        INSERT INTO delivery_plan_unit_dependencies(draft_id, unit_key, depends_on_unit_key)
        VALUES(?, ?, ?)
        ON CONFLICT(draft_id, unit_key, depends_on_unit_key) DO NOTHING
      `).run(draft.draft_id, key, dependsOn);
    } else {
      const removed = db.prepare(`
        DELETE FROM delivery_plan_unit_dependencies
        WHERE draft_id = ? AND unit_key = ? AND depends_on_unit_key = ?
      `).run(draft.draft_id, key, dependsOn);
      if (!removed.changes) throw new Error(`交付单元 ${key} 不依赖 ${dependsOn}`);
    }
    touchDraft(db, draft.draft_id);
    return `交付单元 ${key} 对 ${dependsOn} 的前置依赖已${command.endsWith('add') ? '保存' : '移除'}。`;
  }
  if (command === 'delivery-plan unit move') {
    const key = bounded(required(flags, 'key'), '交付单元 key', 120);
    const requested = Number(required(flags, 'position'));
    if (!Number.isInteger(requested) || requested < 1) throw new Error('--position 必须是从 1 开始的整数');
    const state = deliveryPlanState(db, draft);
    const activeUnits = state.units.filter((unit) => unit.lifecycle_status === 'active');
    const current = activeUnits.find((unit) => unit.unit_key === key);
    if (!current) throw new Error(`交付单元 ${key} 不存在`);
    const reordered = activeUnits.filter((unit) => unit.unit_key !== key);
    reordered.splice(Math.min(requested - 1, reordered.length), 0, current);
    db.transaction(() => {
      for (const [index, unit] of reordered.entries()) {
        db.prepare(`
          UPDATE delivery_plan_units SET ordinal = ?
          WHERE draft_id = ? AND unit_key = ?
        `).run(index + 1, draft.draft_id, unit.unit_key);
      }
      touchDraft(db, draft.draft_id);
    })();
    return `交付单元 ${key} 已移动到第 ${Math.min(requested, reordered.length)} 位。`;
  }
  if (command === 'delivery-plan validate') {
    const errors = deliveryPlanValidationErrors(deliveryPlanState(db, draft));
    if (errors.length) throw new Error(`交付计划校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    return '交付计划草稿结构校验通过。';
  }
  if (command === 'delivery-plan complete') {
    return submitDeliveryPlan(db, draft, execution);
  }
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}

function upsertSimpleItem(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  table: 'requirement_context_constraints',
  draftId: string,
  keyColumn: 'constraint_key',
  key: string,
  content: string,
) {
  const ordinal = nextOrdinal(db, table, draftId);
  db.prepare(`
    INSERT INTO ${table}(draft_id, ${keyColumn}, content, ordinal)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(draft_id, ${keyColumn}) DO UPDATE SET content = excluded.content
  `).run(draftId, key, content, ordinal);
}

function recordContextItemRevision(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  input: {
    draftId: string;
    executionId: string;
    itemType: 'assertion' | 'impact' | 'acceptance';
    itemKey: string;
    action: 'upsert' | 'dismiss' | 'supersede';
  },
) {
  const metadata = input.itemType === 'assertion'
    ? { table: 'requirement_context_assertions', keyColumn: 'assertion_key' }
    : input.itemType === 'impact'
      ? { table: 'requirement_context_impacts', keyColumn: 'impact_key' }
      : { table: 'requirement_context_acceptance_items', keyColumn: 'acceptance_key' };
  const snapshot = db.prepare(`
    SELECT * FROM ${metadata.table}
    WHERE draft_id = ? AND ${metadata.keyColumn} = ?
  `).get(input.draftId, input.itemKey);
  if (!snapshot) throw new Error(`${input.itemType} ${input.itemKey} 无法生成修订记录`);
  db.prepare(`
    INSERT INTO requirement_context_item_revisions(
      draft_id, item_type, item_key, action, snapshot_json, execution_id
    ) VALUES(?, ?, ?, ?, ?, ?)
  `).run(
    input.draftId,
    input.itemType,
    input.itemKey,
    input.action,
    JSON.stringify(snapshot),
    input.executionId,
  );
}

function requireActiveDeliveryPlanUnit(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  draftId: string,
  unitKey: string,
) {
  const unit = db.prepare(`
    SELECT lifecycle_status
    FROM delivery_plan_units
    WHERE draft_id = ? AND unit_key = ?
  `).get(draftId, unitKey) as { lifecycle_status: string } | undefined;
  if (!unit) throw new Error(`交付单元 ${unitKey} 不存在`);
  if (unit.lifecycle_status !== 'active') {
    throw new Error(`交付单元 ${unitKey} 已是 ${unit.lifecycle_status}，不能继续编辑关联`);
  }
}

function recordDeliveryPlanUnitRevision(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  input: {
    draftId: string;
    executionId: string;
    unitKey: string;
    action: 'upsert' | 'dismiss' | 'supersede';
  },
) {
  const snapshot = db.prepare(`
    SELECT * FROM delivery_plan_units
    WHERE draft_id = ? AND unit_key = ?
  `).get(input.draftId, input.unitKey);
  if (!snapshot) throw new Error(`交付单元 ${input.unitKey} 无法生成修订记录`);
  db.prepare(`
    INSERT INTO delivery_plan_unit_revisions(
      draft_id, unit_key, action, snapshot_json, execution_id
    ) VALUES(?, ?, ?, ?, ?)
  `).run(
    input.draftId,
    input.unitKey,
    input.action,
    JSON.stringify(snapshot),
    input.executionId,
  );
}

function reviseDeliveryPlanUnitLifecycle(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  input: {
    draftId: string;
    unitKey: string;
    lifecycle: 'dismissed' | 'superseded';
    reason: string;
    supersededBy?: string;
  },
) {
  requireActiveDeliveryPlanUnit(db, input.draftId, input.unitKey);
  if (input.lifecycle === 'superseded') {
    if (!input.supersededBy || input.supersededBy === input.unitKey) {
      throw new Error('交付单元必须由另一个已经存在的稳定 key 取代');
    }
    requireActiveDeliveryPlanUnit(db, input.draftId, input.supersededBy);
  }
  db.prepare(`
    UPDATE delivery_plan_units
    SET lifecycle_status = ?, lifecycle_reason = ?, superseded_by = ?
    WHERE draft_id = ? AND unit_key = ?
  `).run(
    input.lifecycle,
    input.reason,
    input.lifecycle === 'superseded' ? input.supersededBy : null,
    input.draftId,
    input.unitKey,
  );
}

function reviseContextItemLifecycle(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  input: {
    table: 'requirement_context_assertions' | 'requirement_context_impacts' | 'requirement_context_acceptance_items';
    keyColumn: 'assertion_key' | 'impact_key' | 'acceptance_key';
    draftId: string;
    key: string;
    lifecycle: 'dismissed' | 'superseded';
    reason: string;
    supersededBy?: string;
    label: string;
  },
) {
  const current = db.prepare(`
    SELECT lifecycle_status FROM ${input.table}
    WHERE draft_id = ? AND ${input.keyColumn} = ?
  `).get(input.draftId, input.key) as { lifecycle_status: string } | undefined;
  if (!current) throw new Error(`${input.label} ${input.key} 不存在`);
  if (input.lifecycle === 'superseded') {
    if (!input.supersededBy || input.supersededBy === input.key) {
      throw new Error(`${input.label}必须由另一个已经存在的稳定 key 取代`);
    }
    const replacement = db.prepare(`
      SELECT lifecycle_status FROM ${input.table}
      WHERE draft_id = ? AND ${input.keyColumn} = ?
    `).get(input.draftId, input.supersededBy) as { lifecycle_status: string } | undefined;
    if (!replacement || replacement.lifecycle_status !== 'active') {
      throw new Error(`取代项 ${input.supersededBy} 不存在或不是 active`);
    }
  }
  db.prepare(`
    UPDATE ${input.table}
    SET lifecycle_status = ?, lifecycle_reason = ?, superseded_by = ?
    WHERE draft_id = ? AND ${input.keyColumn} = ?
  `).run(
    input.lifecycle,
    input.reason,
    input.lifecycle === 'superseded' ? input.supersededBy : null,
    input.draftId,
    input.key,
  );
}

export async function issueAgentCommandToken(executionId: string) {
  const db = await databaseConnection();
  const execution = executionInDb(db, executionId);
  const profile = execution
    ? agentCommandProfile(execution.agent, execution.pipeline)
    : null;
  if (!execution || !profile) return null;
  if (profile.draftType === 'development') {
    const workKey = agentCommandWorkKey(
      execution.agent,
      execution.pipeline,
      execution.task_id,
      execution.story_index,
      execution.delegation_key,
    );
    if (!workKey) return null;
    const draft = ensureDraft(db, execution, profile, workKey);
    prepareDevelopmentRepositorySnapshot(db, draft, execution);
  }
  const token = randomBytes(32).toString('hex');
  db.prepare(`
    UPDATE execution_attempts SET command_token_hash = ?, heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
  `).run(hash(token), executionId);
  return token;
}

export async function readAgentCommandSubmission(executionId: string): Promise<AgentResult | null> {
  const db = await databaseConnection();
  const row = db.prepare(`
    SELECT result_json FROM execution_attempts
    WHERE execution_id = ? AND status = 'output_received' AND result_json IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM agent_work_drafts
        WHERE terminal_execution_id = execution_attempts.execution_id
      )
  `).get(executionId) as { result_json: string } | undefined;
  return row ? agentResultSchema.parse(JSON.parse(row.result_json)) : null;
}

export async function runAgentCommand(input: {
  executionId: string;
  token: string;
  args: string[];
}) {
  const { db, execution, profile, workKey } = await authorize(input.executionId, input.token);
  const { positionals, flags } = parseArgs(input.args);
  const command = positionals[0] === 'requirement-context'
      && positionals[1] === 'classification'
      && positionals[2] === 'set'
    ? positionals.slice(0, 3).join(' ')
    : positionals.join(' ');

  if (positionals[0] === 'help') {
    if (positionals.length > 2) throw new Error('help 最多接受一个主题');
    return helpText(execution, profile, positionals[1] || null);
  }
  if (command === 'whoami') {
    return `${execution.agent} · ${execution.pipeline} · execution=${execution.execution_id}`;
  }
  if (!command.startsWith(profile.namespace)) {
    throw new Error(`当前 execution 不允许命令：${command || '(empty)'}。请使用 loop-agent help`);
  }

  let draft = ensureDraft(db, execution, profile, workKey);
  if (profile.draftType === 'delivery_plan') {
    return runDeliveryPlanCommand({ db, execution, draft, command, flags });
  }
  if (profile.draftType === 'reproduction') {
    return runReproductionCommand({ db, execution, draft, command, flags });
  }
  if (profile.draftType === 'analysis') {
    return runDeliveryAnalysisCommand({ db, execution, draft, command, flags });
  }
  if (profile.draftType === 'development') {
    return runDevelopmentCommand({ db, execution, draft, command, flags });
  }
  if (profile.draftType === 'verification') {
    return runVerificationCommand({ db, execution, draft, command, flags });
  }
  if (profile.draftType === 'feedback') {
    return runFeedbackCommand({ db, execution, draft, command, flags });
  }
  if (profile.draftType === 'review') {
    return runReviewCommand({ db, execution, draft, command, flags });
  }
  if (command === 'requirement-context status') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, execution.execution_id, draft.draft_id);
    draft = { ...draft, status_viewed_execution_id: execution.execution_id };
    return renderStatus(draft, draftState(db, draft));
  }
  if (
    (command === 'requirement-context complete'
      || command === 'requirement-context request-clarification')
    && draft.terminal_execution_id === execution.execution_id
    && draft.terminal_action === command.replace('requirement-context ', '')
  ) {
    return '该终止命令已经提交成功，无需重复提交，可以结束本轮。';
  }
  assertViewed(draft, execution.execution_id);

  if (
    command === 'requirement-context intent set'
    || command === 'requirement-context change set'
  ) {
    const column = command.includes('intent') ? 'intent' : 'change_summary';
    const label = column === 'intent' ? '业务意图' : '业务变化摘要';
    const value = bounded(required(flags, 'text'), label);
    db.prepare(`UPDATE requirement_context_drafts SET ${column} = ? WHERE draft_id = ?`).run(value, draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `${label}已保存。`;
  }
  if (command === 'requirement-context assertion upsert') {
    const key = bounded(required(flags, 'key'), '业务语义 key', 120);
    const perspective = required(flags, 'perspective');
    if (!['actual', 'expected', 'target'].includes(perspective)) {
      throw new Error('--perspective 必须是 actual、expected 或 target');
    }
    const evidence = required(flags, 'evidence');
    if (!['observed', 'reported', 'inferred', 'decided', 'conflicted'].includes(evidence)) {
      throw new Error('--evidence 必须是 observed、reported、inferred、decided 或 conflicted');
    }
    const existing = db.prepare(`
      SELECT lifecycle_status FROM requirement_context_assertions
      WHERE draft_id = ? AND assertion_key = ?
    `).get(draft.draft_id, key) as { lifecycle_status: string } | undefined;
    if (existing && existing.lifecycle_status !== 'active') {
      throw new Error(`业务语义 ${key} 已是 ${existing.lifecycle_status}，请使用新的稳定 key 记录新结论`);
    }
    const ordinal = nextOrdinal(db, 'requirement_context_assertions', draft.draft_id);
    db.prepare(`
      INSERT INTO requirement_context_assertions(
        draft_id, assertion_key, perspective, statement, evidence_status,
        source, decision_key, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, assertion_key) DO UPDATE SET
        perspective = excluded.perspective,
        statement = excluded.statement,
        evidence_status = excluded.evidence_status,
        source = excluded.source,
        decision_key = excluded.decision_key
    `).run(
      draft.draft_id,
      key,
      perspective,
      bounded(required(flags, 'statement'), '业务语义陈述'),
      evidence,
      bounded(required(flags, 'source'), '证据来源', 1000),
      optionalBounded(flags, 'decision', 'decision key', 120),
      ordinal,
    );
    recordContextItemRevision(db, {
      draftId: draft.draft_id,
      executionId: execution.execution_id,
      itemType: 'assertion',
      itemKey: key,
      action: 'upsert',
    });
    touchDraft(db, draft.draft_id);
    return `业务语义 ${key} 已保存。`;
  }
  if (
    command === 'requirement-context assertion dismiss'
    || command === 'requirement-context assertion supersede'
  ) {
    const key = bounded(required(flags, 'key'), '业务语义 key', 120);
    const superseded = command.endsWith('supersede');
    reviseContextItemLifecycle(db, {
      table: 'requirement_context_assertions',
      keyColumn: 'assertion_key',
      draftId: draft.draft_id,
      key,
      lifecycle: superseded ? 'superseded' : 'dismissed',
      reason: bounded(required(flags, 'reason'), '修订理由'),
      supersededBy: superseded ? bounded(required(flags, 'by'), '取代项 key', 120) : undefined,
      label: '业务语义',
    });
    recordContextItemRevision(db, {
      draftId: draft.draft_id,
      executionId: execution.execution_id,
      itemType: 'assertion',
      itemKey: key,
      action: superseded ? 'supersede' : 'dismiss',
    });
    touchDraft(db, draft.draft_id);
    return `业务语义 ${key} 已标记为${superseded ? '已取代' : '已排除'}。`;
  }
  if (command === 'requirement-context impact upsert') {
    const key = bounded(required(flags, 'key'), '业务影响 key', 120);
    const disposition = required(flags, 'disposition');
    if (!['change', 'preserve', 'needs_decision', 'technical'].includes(disposition)) {
      throw new Error('--disposition 必须是 change、preserve、needs_decision 或 technical');
    }
    const existing = db.prepare(`
      SELECT lifecycle_status FROM requirement_context_impacts
      WHERE draft_id = ? AND impact_key = ?
    `).get(draft.draft_id, key) as { lifecycle_status: string } | undefined;
    if (existing && existing.lifecycle_status !== 'active') {
      throw new Error(`业务影响 ${key} 已是 ${existing.lifecycle_status}，请使用新的稳定 key 记录新结论`);
    }
    const ordinal = nextOrdinal(db, 'requirement_context_impacts', draft.draft_id);
    db.prepare(`
      INSERT INTO requirement_context_impacts(
        draft_id, impact_key, statement, disposition, rationale,
        source, decision_key, ordinal
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, impact_key) DO UPDATE SET
        statement = excluded.statement,
        disposition = excluded.disposition,
        rationale = excluded.rationale,
        source = excluded.source,
        decision_key = excluded.decision_key
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'statement'), '业务影响'),
      disposition,
      bounded(required(flags, 'rationale'), '影响判断依据'),
      bounded(required(flags, 'source'), '影响来源', 1000),
      optionalBounded(flags, 'decision', 'decision key', 120),
      ordinal,
    );
    recordContextItemRevision(db, {
      draftId: draft.draft_id,
      executionId: execution.execution_id,
      itemType: 'impact',
      itemKey: key,
      action: 'upsert',
    });
    touchDraft(db, draft.draft_id);
    return `业务影响 ${key} 已保存为 ${disposition}。`;
  }
  if (
    command === 'requirement-context impact dismiss'
    || command === 'requirement-context impact supersede'
  ) {
    const key = bounded(required(flags, 'key'), '业务影响 key', 120);
    const superseded = command.endsWith('supersede');
    reviseContextItemLifecycle(db, {
      table: 'requirement_context_impacts',
      keyColumn: 'impact_key',
      draftId: draft.draft_id,
      key,
      lifecycle: superseded ? 'superseded' : 'dismissed',
      reason: bounded(required(flags, 'reason'), '修订理由'),
      supersededBy: superseded ? bounded(required(flags, 'by'), '取代项 key', 120) : undefined,
      label: '业务影响',
    });
    recordContextItemRevision(db, {
      draftId: draft.draft_id,
      executionId: execution.execution_id,
      itemType: 'impact',
      itemKey: key,
      action: superseded ? 'supersede' : 'dismiss',
    });
    touchDraft(db, draft.draft_id);
    return `业务影响 ${key} 已标记为${superseded ? '已取代' : '已排除'}。`;
  }
  if (command === 'requirement-context acceptance upsert') {
    const key = bounded(required(flags, 'key'), '验收语义 key', 120);
    const existing = db.prepare(`
      SELECT lifecycle_status FROM requirement_context_acceptance_items
      WHERE draft_id = ? AND acceptance_key = ?
    `).get(draft.draft_id, key) as { lifecycle_status: string } | undefined;
    if (existing && existing.lifecycle_status !== 'active') {
      throw new Error(`验收语义 ${key} 已是 ${existing.lifecycle_status}，请使用新的稳定 key 记录新结论`);
    }
    const ordinal = nextOrdinal(db, 'requirement_context_acceptance_items', draft.draft_id);
    db.prepare(`
      INSERT INTO requirement_context_acceptance_items(
        draft_id, acceptance_key, content, source, ordinal
      ) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, acceptance_key) DO UPDATE SET
        content = excluded.content,
        source = excluded.source
    `).run(
      draft.draft_id,
      key,
      bounded(required(flags, 'text'), '验收语义'),
      bounded(required(flags, 'source'), '验收语义来源', 1000),
      ordinal,
    );
    recordContextItemRevision(db, {
      draftId: draft.draft_id,
      executionId: execution.execution_id,
      itemType: 'acceptance',
      itemKey: key,
      action: 'upsert',
    });
    touchDraft(db, draft.draft_id);
    return `验收语义 ${key} 已保存。`;
  }
  if (
    command === 'requirement-context acceptance dismiss'
    || command === 'requirement-context acceptance supersede'
  ) {
    const key = bounded(required(flags, 'key'), '验收语义 key', 120);
    const superseded = command.endsWith('supersede');
    reviseContextItemLifecycle(db, {
      table: 'requirement_context_acceptance_items',
      keyColumn: 'acceptance_key',
      draftId: draft.draft_id,
      key,
      lifecycle: superseded ? 'superseded' : 'dismissed',
      reason: bounded(required(flags, 'reason'), '修订理由'),
      supersededBy: superseded ? bounded(required(flags, 'by'), '取代项 key', 120) : undefined,
      label: '验收语义',
    });
    recordContextItemRevision(db, {
      draftId: draft.draft_id,
      executionId: execution.execution_id,
      itemType: 'acceptance',
      itemKey: key,
      action: superseded ? 'supersede' : 'dismiss',
    });
    touchDraft(db, draft.draft_id);
    return `验收语义 ${key} 已标记为${superseded ? '已取代' : '已排除'}。`;
  }
  if (command === 'requirement-context classification set') {
    const classification = positionals[3];
    if (!['feature', 'bug', 'tech', 'other'].includes(classification)) {
      throw new Error('分类必须是 feature、bug、tech 或 other');
    }
    db.prepare('UPDATE requirement_context_drafts SET classification = ? WHERE draft_id = ?')
      .run(classification, draft.draft_id);
    touchDraft(db, draft.draft_id);
    return `需求分类已设置为 ${classification}；后续 plan/repro 路由由系统确定。`;
  }
  if (command === 'requirement-context constraint add') {
    upsertSimpleItem(
      db,
      'requirement_context_constraints',
      draft.draft_id,
      'constraint_key',
      bounded(required(flags, 'key'), '约束 key', 120),
      bounded(required(flags, 'text'), '约束'),
    );
    touchDraft(db, draft.draft_id);
    return '约束已保存。';
  }
  if (command === 'requirement-context constraint remove') {
    db.prepare('DELETE FROM requirement_context_constraints WHERE draft_id = ? AND constraint_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '约束已删除。';
  }
  if (command === 'requirement-context scope include' || command === 'requirement-context scope exclude') {
    const direction = command.endsWith('include') ? 'included' : 'excluded';
    const key = bounded(required(flags, 'key'), '范围 key', 120);
    const content = bounded(required(flags, 'text'), '范围内容');
    const ordinal = nextOrdinal(db, 'requirement_context_scope_items', draft.draft_id);
    db.prepare(`
      INSERT INTO requirement_context_scope_items(draft_id, scope_key, direction, content, ordinal)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(draft_id, scope_key) DO UPDATE SET
        direction = excluded.direction, content = excluded.content
    `).run(draft.draft_id, key, direction, content, ordinal);
    touchDraft(db, draft.draft_id);
    return `范围 ${key} 已保存为${direction === 'included' ? '包含' : '排除'}。`;
  }
  if (command === 'requirement-context scope remove') {
    db.prepare('DELETE FROM requirement_context_scope_items WHERE draft_id = ? AND scope_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '范围项已删除。';
  }
  if (command === 'requirement-context question add') {
    const key = bounded(required(flags, 'key'), '问题 key', 120);
    const ordinal = nextOrdinal(db, 'requirement_context_questions', draft.draft_id);
    db.prepare(`
      INSERT INTO requirement_context_questions(
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
    return `问题 ${key} 已保存。`;
  }
  if (command === 'requirement-context question option-add') {
    const key = bounded(required(flags, 'key'), '问题 key', 120);
    const exists = db.prepare(`
      SELECT 1 FROM requirement_context_questions WHERE draft_id = ? AND decision_key = ?
    `).get(draft.draft_id, key);
    if (!exists) throw new Error(`问题 ${key} 不存在，请先使用 question add`);
    const ordinal = nextOrdinal(db, 'requirement_context_question_options', draft.draft_id);
    db.prepare(`
      INSERT INTO requirement_context_question_options(
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
  if (command === 'requirement-context question recommend') {
    const key = bounded(required(flags, 'key'), '问题 key', 120);
    const option = bounded(required(flags, 'option'), '推荐选项', 120);
    const exists = db.prepare(`
      SELECT 1 FROM requirement_context_question_options
      WHERE draft_id = ? AND decision_key = ? AND option_id = ?
    `).get(draft.draft_id, key, option);
    if (!exists) throw new Error(`问题 ${key} 不存在选项 ${option}`);
    db.prepare(`
      UPDATE requirement_context_questions
      SET recommendation_option_id = ?, recommendation_reason = ?
      WHERE draft_id = ? AND decision_key = ?
    `).run(option, bounded(required(flags, 'reason'), '推荐理由'), draft.draft_id, key);
    touchDraft(db, draft.draft_id);
    return `问题 ${key} 的推荐答案已保存。`;
  }
  if (command === 'requirement-context question remove') {
    db.prepare('DELETE FROM requirement_context_questions WHERE draft_id = ? AND decision_key = ?')
      .run(draft.draft_id, required(flags, 'key'));
    touchDraft(db, draft.draft_id);
    return '问题已删除。';
  }
  if (command === 'requirement-context validate') {
    const current = draftState(db, draft);
    const clarification = current.questions.some((question) => !question.answer);
    const errors = validationErrors(current, clarification ? 'request-clarification' : null);
    if (errors.length) throw new Error(`草稿校验失败：\n${errors.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    return clarification
      ? '业务变化上下文澄清草稿校验通过，可以提交 request-clarification。'
      : '业务变化上下文草稿结构校验通过；complete 仍会校验分类和未回答问题。';
  }
  if (command === 'requirement-context complete') {
    return terminalSubmit(db, draft, execution, 'complete');
  }
  if (command === 'requirement-context request-clarification') {
    return terminalSubmit(db, draft, execution, 'request-clarification');
  }
  throw new Error(`未知命令：${command}。请使用 loop-agent help`);
}

export const agentCommandDraftInternals = {
  parseArgs,
  validationErrors,
  renderArtifact,
  buildResult,
  deliveryPlanValidationErrors,
  renderDeliveryPlanArtifact,
  buildDeliveryPlanResult,
};
