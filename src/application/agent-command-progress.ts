import type Database from 'better-sqlite3';
import { agentCommandProfile } from '../domain/agent-command-profile';
import { businessAnalysisPhases, businessAnalysisWorkflow, type BusinessAnalysisAgentId } from '../domain/business-analysis-workflow';
import { DELIVERY_ANALYSIS_PHASE_ORDER, DELIVERY_ANALYSIS_WORKFLOW } from '../domain/delivery-analysis-workflow';
import { DELIVERY_PLAN_PHASE_ORDER, DELIVERY_PLAN_WORKFLOW } from '../domain/delivery-plan-workflow';
import { DEVELOPMENT_PHASE_ORDER, DEVELOPMENT_WORKFLOW } from '../domain/development-workflow';
import { REQUIREMENT_CONTEXT_PHASE_ORDER } from '../domain/requirement-context-workflow';
import { REVIEW_PHASE_ORDER, REVIEW_WORKFLOW } from '../domain/review-workflow';
import { VERIFICATION_PHASE_ORDER, VERIFICATION_WORKFLOW } from '../domain/verification-workflow';
import { databaseConnection } from '../infrastructure/database';

export type AgentCommandProgressStage = {
  id: string;
  label: string;
  status: 'completed' | 'current' | 'pending';
};

export type AgentCommandProgress = {
  executionId: string | null;
  agent: string;
  pipeline: string;
  storyIndex: number | null;
  state: 'running' | 'waiting' | 'retrying' | 'blocked' | 'applying' | 'editing';
  stateLabel: string;
  currentPhase: string;
  stages: AgentCommandProgressStage[];
  latestCommand: {
    label: string;
    status: 'running' | 'success' | 'error';
    createdAt: string;
  } | null;
  updatedAt: string;
};

type DraftProgressRow = {
  draft_id: string;
  draft_type: string;
  agent: string;
  status: string;
  change_seq: number;
  story_index: number | null;
  last_execution_id: string | null;
  status_viewed_execution_id: string | null;
  updated_at: string;
  workflow_phase: string | null;
  research_enabled: number | null;
  review_branch: string | null;
  execution_status: string | null;
  pipeline: string | null;
};

type ActiveExecutionRow = {
  execution_id: string;
  agent: string;
  pipeline: string;
  story_index: number | null;
  status: string;
  updated_at: string;
};

type ToolReceiptRow = {
  payload_json: string;
  created_at: string;
};

type PhaseDefinition = { order: readonly string[]; labels: Record<string, string> };

const REQUIREMENT_CONTEXT_LABELS: Record<string, string> = {
  as_is: '现状基线',
  decision_proposal: '决策提出',
  decision_resolution: '决策收敛',
  answer_review: '答案复核',
  to_be: '目标状态',
  impact_scan: '影响扫描',
  scope: '范围边界',
  acceptance: '验收语义',
  finalize: '最终提交',
};

const BUSINESS_ANALYSIS_LABELS: Record<string, string> = {
  discovery: '需求调查', research: '实时调研', clarification_proposal: '澄清提出',
  clarification_resolution: '澄清收敛', synthesis: '需求综合', exploration: '方案探索',
  decision_proposal: '决策提出', decision_resolution: '决策收敛', solution: '业务方案',
  composition: '规格编写', verification: '规格校验', inspection: '独立检查',
  classification: '缺口分类', verdict: '审查结论', finalize: '最终提交',
};

const WORKFLOW_PHASE_LABELS: Record<string, string> = {
  planning_basis: '拆分依据', delivery_units: '交付单元', coverage_order: '覆盖与排序',
  impact_scan: '影响扫描', decision_proposal: '决策提出', decision_resolution: '决策收敛',
  answer_review: '答案复核', delivery_contract: '交付契约', implement: '实现', review: '代码审查',
  developer_verify: '开发者验证', commit: '代码提交', plan: '验证计划', execute: '执行验证',
  evidence_review: '证据复核', fact_reconciliation: '事实对账', closure_assessment: '结卡评估',
  report: '生成报告', forward_units: '前向补齐', finalize: '最终提交',
};

const phaseLabels = <T extends string>(order: readonly T[], workflow: Record<T, { title: string }>) =>
  Object.fromEntries(order.map((phase) => [phase, WORKFLOW_PHASE_LABELS[phase] || workflow[phase].title])) as Record<string, string>;

function phaseDefinition(row: DraftProgressRow): PhaseDefinition {
  if (row.draft_type === 'requirement_context') {
    return { order: REQUIREMENT_CONTEXT_PHASE_ORDER, labels: REQUIREMENT_CONTEXT_LABELS };
  }
  if (row.draft_type === 'delivery_plan') {
    return { order: DELIVERY_PLAN_PHASE_ORDER, labels: phaseLabels(DELIVERY_PLAN_PHASE_ORDER, DELIVERY_PLAN_WORKFLOW) };
  }
  if (row.draft_type === 'analysis') {
    return { order: DELIVERY_ANALYSIS_PHASE_ORDER, labels: phaseLabels(DELIVERY_ANALYSIS_PHASE_ORDER, DELIVERY_ANALYSIS_WORKFLOW) };
  }
  if (row.draft_type === 'development') {
    return { order: DEVELOPMENT_PHASE_ORDER, labels: phaseLabels(DEVELOPMENT_PHASE_ORDER, DEVELOPMENT_WORKFLOW) };
  }
  if (row.draft_type === 'verification') {
    return { order: VERIFICATION_PHASE_ORDER, labels: phaseLabels(VERIFICATION_PHASE_ORDER, VERIFICATION_WORKFLOW) };
  }
  if (row.draft_type === 'review') {
    const branch = row.workflow_phase === 'forward_units' || row.review_branch === 'forward_units'
      ? 'forward_units'
      : 'report';
    const order = REVIEW_PHASE_ORDER.filter((phase) => phase !== (branch === 'forward_units' ? 'report' : 'forward_units'));
    return { order, labels: phaseLabels(REVIEW_PHASE_ORDER, REVIEW_WORKFLOW) };
  }
  if (row.draft_type === 'business_analysis') {
    const workflow = businessAnalysisWorkflow(row.agent);
    if (workflow) {
      const order = businessAnalysisPhases(row.agent as BusinessAnalysisAgentId, Boolean(row.research_enabled));
      return { order, labels: { ...BUSINESS_ANALYSIS_LABELS } };
    }
  }
  if (row.draft_type === 'reproduction') {
    return { order: ['restore', 'investigate', 'finalize'], labels: { restore: '恢复现场', investigate: '复现与取证', finalize: '校验提交' } };
  }
  if (row.draft_type === 'feedback') {
    return { order: ['restore', 'process', 'finalize'], labels: { restore: '恢复反馈', process: '处理反馈', finalize: '提交结论' } };
  }
  return { order: ['restore', 'work', 'finalize'], labels: { restore: '恢复状态', work: '执行工作', finalize: '提交结果' } };
}

function inferredGenericPhase(row: DraftProgressRow, definition: PhaseDefinition) {
  if (row.status === 'submitted') return definition.order.at(-1) || definition.order[0];
  if (row.status === 'waiting_for_answers') return definition.order.at(-1) || definition.order[0];
  if (!row.last_execution_id || row.status_viewed_execution_id !== row.last_execution_id) return definition.order[0];
  return definition.order[1] || definition.order[0];
}

function progressState(executionStatus: string | null, draftStatus: string) {
  if (draftStatus === 'waiting_for_answers') return { state: 'waiting' as const, stateLabel: '等待人工输入' };
  if (executionStatus === 'retryable_failed') return { state: 'retrying' as const, stateLabel: '等待自动重试' };
  if (executionStatus === 'system_blocked') return { state: 'blocked' as const, stateLabel: '执行已阻塞' };
  if (executionStatus === 'output_received' || executionStatus === 'verifying' || executionStatus === 'applying') {
    return { state: 'applying' as const, stateLabel: '正在应用结果' };
  }
  if (executionStatus === 'planned' || executionStatus === 'running') return { state: 'running' as const, stateLabel: 'Agent 执行中' };
  return { state: 'editing' as const, stateLabel: '草稿推进中' };
}

function directProgress(row: ActiveExecutionRow): AgentCommandProgress {
  const applying = ['output_received', 'verifying', 'applying'].includes(row.status);
  const failed = row.status === 'system_blocked';
  const retrying = row.status === 'retryable_failed';
  const stages: AgentCommandProgressStage[] = [
    { id: 'execute', label: '执行需求', status: applying ? 'completed' : 'current' },
    { id: 'submit', label: '提交结果', status: applying ? 'current' : 'pending' },
  ];
  return {
    executionId: row.execution_id,
    agent: row.agent,
    pipeline: row.pipeline,
    storyIndex: row.story_index,
    state: failed ? 'blocked' : retrying ? 'retrying' : applying ? 'applying' : 'running',
    stateLabel: failed ? '执行已阻塞' : retrying ? '等待自动重试' : applying ? '正在应用结果' : 'Agent 执行中',
    currentPhase: applying ? 'submit' : 'execute',
    stages,
    latestCommand: null,
    updatedAt: row.updated_at,
  };
}

function latestDomainCommand(db: Database.Database, executionId: string | null) {
  if (!executionId) return null;
  const rows = db.prepare(`
    SELECT payload_json, created_at
    FROM execution_receipts
    WHERE execution_id = ? AND kind = 'tool_event'
    ORDER BY receipt_key DESC
    LIMIT 120
  `).all(executionId) as ToolReceiptRow[];
  const events = rows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const input = payload.input as Record<string, unknown> | undefined;
      const command = typeof input?.command === 'string' ? input.command : '';
      if (!/loop-agent\.(?:mjs|cjs)/i.test(command)) return [];
      return [{ payload, createdAt: row.created_at }];
    } catch {
      return [];
    }
  });
  const latest = events[0];
  if (!latest) return null;
  const commandHash = String(latest.payload.commandHash || '');
  const started = events.find((event) => event.payload.phase === 'started'
    && (!commandHash || event.payload.commandHash === commandHash));
  const phase = String(latest.payload.phase || '');
  const success = latest.payload.success;
  return {
    label: String(started?.payload.summary || (phase === 'started' ? latest.payload.summary : '') || '执行 Agent 领域命令'),
    status: phase === 'started' ? 'running' as const : success === true ? 'success' as const : 'error' as const,
    createdAt: latest.createdAt,
  };
}

function buildDraftProgress(db: Database.Database, row: DraftProgressRow): AgentCommandProgress {
  const definition = phaseDefinition(row);
  const structuredPhase = row.workflow_phase && definition.order.includes(row.workflow_phase)
    ? row.workflow_phase
    : null;
  const currentPhase = structuredPhase || inferredGenericPhase(row, definition);
  const currentIndex = Math.max(0, definition.order.indexOf(currentPhase));
  const submitted = row.status === 'submitted';
  const stages = definition.order.map((phase, index): AgentCommandProgressStage => ({
    id: phase,
    label: definition.labels[phase] || phase,
    status: submitted || index < currentIndex ? 'completed' : index === currentIndex ? 'current' : 'pending',
  }));
  const state = progressState(row.execution_status, row.status);
  return {
    executionId: row.last_execution_id,
    agent: row.agent,
    pipeline: row.pipeline || '',
    storyIndex: row.story_index,
    ...state,
    currentPhase,
    stages,
    latestCommand: latestDomainCommand(db, row.last_execution_id),
    updatedAt: row.updated_at,
  };
}

export function agentCommandProgressInDb(db: Database.Database, taskId: string) {
  const drafts = db.prepare(`
    SELECT work.draft_id, work.draft_type, work.agent, work.status, work.change_seq,
           work.story_index, work.last_execution_id, work.status_viewed_execution_id,
           work.updated_at,
           COALESCE(context.workflow_phase, plan.workflow_phase, analysis.workflow_phase,
                    development.workflow_phase, verification.workflow_phase,
                    review.workflow_phase, business.workflow_phase) AS workflow_phase,
           business.research_enabled,
           (SELECT transition.from_phase
            FROM review_phase_transitions transition
            WHERE transition.draft_id = work.draft_id
            ORDER BY transition.transition_id DESC LIMIT 1) AS review_branch,
           execution.status AS execution_status, execution.pipeline
    FROM agent_work_drafts work
    LEFT JOIN requirement_context_drafts context ON context.draft_id = work.draft_id
    LEFT JOIN delivery_plan_drafts plan ON plan.draft_id = work.draft_id
    LEFT JOIN delivery_analysis_drafts analysis ON analysis.draft_id = work.draft_id
    LEFT JOIN development_drafts development ON development.draft_id = work.draft_id
    LEFT JOIN verification_drafts verification ON verification.draft_id = work.draft_id
    LEFT JOIN review_drafts review ON review.draft_id = work.draft_id
    LEFT JOIN business_analysis_drafts business ON business.draft_id = work.draft_id
    LEFT JOIN execution_attempts execution ON execution.execution_id = work.last_execution_id
    WHERE work.task_id = ?
      AND work.draft_version = (
        SELECT MAX(latest.draft_version) FROM agent_work_drafts latest
        WHERE latest.work_key = work.work_key
      )
      AND execution.status = 'running'
    ORDER BY work.updated_at DESC, work.draft_id
  `).all(taskId) as DraftProgressRow[];

  const draftExecutionIds = new Set(drafts.flatMap((draft) => draft.last_execution_id ? [draft.last_execution_id] : []));
  const activeExecutions = db.prepare(`
    SELECT execution_id, agent, pipeline, story_index, status,
           COALESCE(heartbeat_at, started_at, created_at) AS updated_at
    FROM execution_attempts
    WHERE task_id = ?
      AND status = 'running'
    ORDER BY created_at DESC, execution_id
  `).all(taskId) as ActiveExecutionRow[];

  const progress = drafts.map((draft) => buildDraftProgress(db, draft));
  for (const execution of activeExecutions) {
    if (draftExecutionIds.has(execution.execution_id)) continue;
    const profile = agentCommandProfile(execution.agent, execution.pipeline);
    if (!profile || profile.draftType === 'direct') {
      const direct = directProgress(execution);
      direct.latestCommand = latestDomainCommand(db, execution.execution_id);
      progress.push(direct);
      continue;
    }
    const provisional: DraftProgressRow = {
      draft_id: '', draft_type: profile.draftType, agent: execution.agent, status: 'editing',
      change_seq: 0, story_index: execution.story_index, last_execution_id: execution.execution_id,
      status_viewed_execution_id: null, updated_at: execution.updated_at, workflow_phase: null,
      research_enabled: 0, review_branch: null, execution_status: execution.status, pipeline: execution.pipeline,
    };
    progress.push(buildDraftProgress(db, provisional));
  }
  return progress.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getAgentCommandProgress(taskId: string) {
  const db = await databaseConnection();
  return agentCommandProgressInDb(db, taskId);
}
