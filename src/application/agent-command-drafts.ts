import { randomBytes, randomUUID } from 'node:crypto';
import { agentResultSchema, type AgentResult } from '../domain/agent-result';
import {
  agentCommandProfile,
  agentCommandWorkKey,
  type AgentCommandProfile,
} from '../domain/agent-command-profile';
import { databaseConnection, hash } from '../infrastructure/database';
import {
  reproductionHelp,
  runReproductionCommand,
} from './reproduction-command-drafts';
import {
  analysisHelp,
  runAnalysisCommand,
} from './analysis-command-drafts';
import {
  developmentHelp,
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
  ordinal: number;
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
      observable_outcome, acceptance, ordinal
    )
    SELECT ?, unit_key, title, actor, trigger_condition,
           observable_outcome, acceptance, ordinal
    FROM delivery_plan_units WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
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

function cloneAnalysisDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  db.prepare(`
    INSERT INTO analysis_drafts(draft_id, goal)
    SELECT ?, goal FROM analysis_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['analysis_scope_items', 'scope_key, direction, content, ordinal'],
    ['analysis_behaviors', 'behavior_key, scenario, expected, ordinal'],
    ['analysis_decisions', `decision_key, title, question, impact, status,
      selected_option_id, source, decision_text, rationale, evidence,
      recommendation_option_id, recommendation_reason, depends_on_json, ordinal`],
    ['analysis_acceptance_criteria', 'criterion_key, description, oracle, ordinal'],
    ['analysis_dependencies', 'dependency_key, content, ordinal'],
    ['analysis_budget_items', 'budget_key, kind, content, ordinal'],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
  db.prepare(`
    INSERT INTO analysis_decision_options(
      draft_id, decision_key, option_id, label, consequence, ordinal
    )
    SELECT ?, decision_key, option_id, label, consequence, ordinal
    FROM analysis_decision_options WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  db.prepare(`
    INSERT INTO analysis_verification_steps(
      draft_id, verification_key, criterion_key, kind, instruction, command, ordinal
    )
    SELECT ?, verification_key, criterion_key, kind, instruction, command, ordinal
    FROM analysis_verification_steps WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
}

function cloneDevelopmentDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  db.prepare(`
    INSERT INTO development_drafts(
      draft_id, summary, assessment_mode, implementation_notes, commit_sha, failure_summary
    )
    SELECT ?, summary, assessment_mode, implementation_notes, commit_sha, failure_summary
    FROM development_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['development_criteria', 'criterion_key, status, evidence, ordinal'],
    ['development_changes', 'path, summary, ordinal'],
    ['development_tests', 'test_key, command, passed, summary, ordinal'],
    ['development_risks', 'risk_key, content, ordinal'],
    ['development_runtime_inputs', 'request_key, title, question, why, recommendation, ordinal'],
    ['development_recovery_resolutions', 'recovery_id, summary, evidence, ordinal'],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
  }
}

function cloneVerificationDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  source: DraftRow,
  target: DraftRow,
) {
  db.prepare(`
    INSERT INTO verification_drafts(
      draft_id, summary, failure_kind, expected_behavior, actual_behavior
    )
    SELECT ?, summary, failure_kind, expected_behavior, actual_behavior
    FROM verification_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['verification_criteria', 'criterion_key, status, method, evidence, ordinal'],
    ['verification_checks', 'check_key, kind, instruction, command, passed, exit_code, summary, ordinal'],
    ['verification_risks', 'risk_key, content, ordinal'],
    ['verification_runtime_inputs', 'request_key, title, question, why, recommendation, ordinal'],
    ['verification_recovery_checks', 'recovery_id, status, evidence, ordinal'],
  ] as const) {
    db.prepare(`
      INSERT INTO ${table[0]}(draft_id, ${table[1]})
      SELECT ?, ${table[1]} FROM ${table[0]} WHERE draft_id = ?
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
    INSERT INTO review_drafts(draft_id, title, summary)
    SELECT ?, title, summary FROM review_drafts WHERE draft_id = ?
  `).run(target.draft_id, source.draft_id);
  for (const table of [
    ['review_sections', 'section_kind, heading, content'],
    ['review_evidence', 'evidence_key, section_kind, reference, claim, ordinal'],
    ['review_runtime_inputs', 'request_key, title, question, why, recommendation, ordinal'],
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
    else db.prepare('INSERT INTO delivery_plan_drafts(draft_id) VALUES(?)').run(draftId);
  } else if (profile.draftType === 'reproduction') {
    if (source) cloneReproductionDraft(db, source, created);
    else db.prepare('INSERT INTO reproduction_drafts(draft_id) VALUES(?)').run(draftId);
  } else if (profile.draftType === 'analysis') {
    if (source) cloneAnalysisDraft(db, source, created);
    else db.prepare('INSERT INTO analysis_drafts(draft_id) VALUES(?)').run(draftId);
  } else if (profile.draftType === 'development') {
    if (source) cloneDevelopmentDraft(db, source, created);
    else db.prepare('INSERT INTO development_drafts(draft_id) VALUES(?)').run(draftId);
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
    else db.prepare('INSERT INTO review_drafts(draft_id) VALUES(?)').run(draftId);
  }
  return created;
}

function ensureDraft(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  execution: ExecutionRow,
  profile: AgentCommandProfile,
  workKey: string,
) {
  const latest = latestDraft(db, workKey);
  if (!latest) return createDraft(db, execution, profile, workKey);
  if (latest.last_execution_id === execution.execution_id) return latest;
  if (latest.status === 'editing') {
    db.prepare(`
      UPDATE agent_work_drafts
      SET last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(execution.execution_id, latest.draft_id);
    return { ...latest, last_execution_id: execution.execution_id };
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
      ? assertions.map((item) =>
        `- ${item.statement}（证据状态：${item.evidence_status}；来源：${item.source}`
        + `${item.decision_key ? `；decision：${item.decision_key}` : ''}）`)
      : [`- ${fallback}`];
  };
  const impactSection = (disposition: ContextImpact['disposition'], fallback: string) => {
    const impacts = state.impacts.filter((item) =>
      item.disposition === disposition && item.lifecycle_status === 'active');
    return impacts.length
      ? impacts.map((item) =>
        `- ${item.statement}（依据：${item.rationale}；来源：${item.source}`
        + `${item.decision_key ? `；decision：${item.decision_key}` : ''}）`)
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
          .map((item) => `- ${item.content}（来源：${item.source}）`)
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
  const inactiveAssertions = state.assertions.filter((item) => item.lifecycle_status !== 'active');
  const inactiveImpacts = state.impacts.filter((item) => item.lifecycle_status !== 'active');
  const inactiveAcceptance = state.acceptance.filter((item) => item.lifecycle_status !== 'active');
  if (inactiveAssertions.length || inactiveImpacts.length || inactiveAcceptance.length) {
    lines.push('', '## 已修正的历史结论', '');
    for (const item of inactiveAssertions) {
      lines.push(`- 业务语义 \`${item.assertion_key}\`：${item.lifecycle_status}；${item.lifecycle_reason || '未记录原因'}`);
    }
    for (const item of inactiveImpacts) {
      lines.push(`- 业务影响 \`${item.impact_key}\`：${item.lifecycle_status}；${item.lifecycle_reason || '未记录原因'}`);
    }
    for (const item of inactiveAcceptance) {
      lines.push(`- 验收语义 \`${item.acceptance_key}\`：${item.lifecycle_status}；${item.lifecycle_reason || '未记录原因'}`);
    }
  }
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
    SELECT unit_key, title, actor, trigger_condition, observable_outcome, acceptance, ordinal
    FROM delivery_plan_units
    WHERE draft_id = ?
    ORDER BY ordinal, unit_key
  `).all(draft.draft_id) as DeliveryPlanUnit[];
  return { plan, units };
}

function deliveryPlanValidationErrors(state: ReturnType<typeof deliveryPlanState>) {
  const errors: string[] = [];
  if (!state.plan.rationale?.trim()) {
    errors.push('缺少拆分依据：使用 delivery-plan rationale set --text <内容>');
  }
  if (!state.plan.coverage?.trim()) {
    errors.push('缺少整体覆盖说明：使用 delivery-plan coverage set --text <内容>');
  }
  if (!state.units.length) {
    errors.push('至少需要一个可独立交付的交付单元');
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
    `交付单元：${state.units.length}`,
  ];
  if (state.units.length) {
    lines.push('', '交付单元索引（跨轮次编辑必须复用 unit key）：');
    for (const [index, unit] of state.units.entries()) {
      lines.push(
        `${index + 1}. ${unit.unit_key}：${unit.title}`,
        `   参与者：${unit.actor}`,
        `   触发条件：${unit.trigger_condition}`,
        `   可观察结果：${unit.observable_outcome}`,
        `   验收标准：${unit.acceptance}`,
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
  for (const [index, unit] of state.units.entries()) {
    lines.push(
      `### ${index + 1}. ${unit.title}`,
      '',
      `- 稳定标识：\`${unit.unit_key}\``,
      `- 参与者：${unit.actor}`,
      `- 触发条件：${unit.trigger_condition}`,
      `- 用户可观察结果：${unit.observable_outcome}`,
      `- 验收标准：${unit.acceptance}`,
      '',
    );
  }
  return lines.join('\n').trim();
}

function buildDeliveryPlanResult(state: ReturnType<typeof deliveryPlanState>) {
  return agentResultSchema.parse({
    outcome: 'completed',
    summary: `已规划 ${state.units.length} 个可独立交付的交付单元`,
    artifact: {
      title: '交付计划',
      content: renderDeliveryPlanArtifact(state),
    },
    deliveryUnits: state.units.map((unit) => ({ title: unit.title })),
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

function helpText(execution: ExecutionRow, profile: AgentCommandProfile) {
  const common = [
    `当前身份：${execution.agent} · ${execution.pipeline}`,
    '',
    '每次启动必须先执行：',
    `  ${profile.namespace} status`,
    '',
    '草稿命令：',
  ];
  if (profile.draftType === 'delivery_plan') {
    return [
      ...common,
      '  delivery-plan rationale set --text <拆分依据>',
      '  delivery-plan coverage set --text <整体覆盖说明>',
      '  delivery-plan ordering set --text <排序与依赖说明>',
      '  delivery-plan unit upsert --key <稳定key> --title <标题> --actor <参与者> --trigger <触发条件> --outcome <可观察结果> --acceptance <验收标准>',
      '  delivery-plan unit remove --key <稳定key>',
      '  delivery-plan unit move --key <稳定key> --position <从1开始的位置>',
      '  delivery-plan validate',
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
      '',
      '终止命令：',
      ...profile.terminalActions.map((action) => `  ${action}`),
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
      ...analysisHelp(profile.terminalActions),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  if (profile.draftType === 'development') {
    return [
      ...common,
      ...developmentHelp(profile.terminalActions),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  if (profile.draftType === 'verification') {
    return [
      ...common,
      ...verificationHelp(profile.terminalActions),
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
      ...reviewHelp(profile.terminalActions),
      '',
      '长文本参数：',
      '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    ].join('\n');
  }
  return [
    ...common,
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
    '',
    '长文本参数：',
    '  任意参数都可使用对应的 --*-file 参数读取 UTF-8 文件',
    '',
    '终止命令：',
    ...profile.terminalActions.map((action) => `  ${action}`),
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
    touchDraft(db, draft.draft_id);
    return `交付单元 ${key} 已保存。`;
  }
  if (command === 'delivery-plan unit remove') {
    const key = bounded(required(flags, 'key'), '交付单元 key', 120);
    const removed = db.prepare(`
      DELETE FROM delivery_plan_units WHERE draft_id = ? AND unit_key = ?
    `).run(draft.draft_id, key);
    if (!removed.changes) throw new Error(`交付单元 ${key} 不存在`);
    touchDraft(db, draft.draft_id);
    return `交付单元 ${key} 已删除。`;
  }
  if (command === 'delivery-plan unit move') {
    const key = bounded(required(flags, 'key'), '交付单元 key', 120);
    const requested = Number(required(flags, 'position'));
    if (!Number.isInteger(requested) || requested < 1) throw new Error('--position 必须是从 1 开始的整数');
    const state = deliveryPlanState(db, draft);
    const current = state.units.find((unit) => unit.unit_key === key);
    if (!current) throw new Error(`交付单元 ${key} 不存在`);
    const reordered = state.units.filter((unit) => unit.unit_key !== key);
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
  if (!execution || !agentCommandProfile(execution.agent, execution.pipeline)) return null;
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

  if (command === 'help') {
    return helpText(execution, profile);
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
    return runAnalysisCommand({ db, execution, draft, command, flags });
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
