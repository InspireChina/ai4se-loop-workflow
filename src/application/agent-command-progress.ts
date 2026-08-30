import type Database from 'better-sqlite3';
import { agentCommandProfile } from '../domain/agent-command-profile';
import { loadCommandChainDefinition } from '../domain/command-chain-definition';
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

export type AgentCommandAuditRecord = {
  executionId: string;
  id: string;
  label: string;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt: string | null;
};

type DraftProgressRow = {
  draft_id: string;
  draft_type: string;
  command_chain_id: string | null;
  agent: string;
  status: string;
  change_seq: number;
  story_index: number | null;
  last_execution_id: string | null;
  status_viewed_execution_id: string | null;
  updated_at: string;
  workflow_phase: string | null;
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
  execution_id?: string;
  receipt_key: string;
  payload_json: string;
  created_at: string;
};

type DomainCommandEvent = {
  executionId: string;
  receiptKey: string;
  toolCallId: string;
  commandHash: string;
  phase: string;
  summary: string;
  success: boolean | null;
  createdAt: string;
};

type PhaseDefinition = { order: readonly string[]; labels: Record<string, string> };

function phaseDefinition(row: DraftProgressRow): PhaseDefinition {
  if (row.command_chain_id) {
    const definition = loadCommandChainDefinition(row.command_chain_id);
    const order = Object.keys(definition.phases);
    return {
      order,
      labels: Object.fromEntries(order.map((phase) => [phase, definition.phases[phase].title])),
    };
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

function verificationAssistanceProgress(db: Database.Database, row: ActiveExecutionRow): AgentCommandProgress {
  const job = db.prepare(`
    SELECT attempt_count, max_attempts, status_viewed_session_id
    FROM verification_assistance_jobs WHERE current_execution_id = ?
  `).get(row.execution_id) as {
    attempt_count: number;
    max_attempts: number;
    status_viewed_session_id: string | null;
  } | undefined;
  const inspected = Boolean(job?.status_viewed_session_id);
  return {
    executionId: row.execution_id,
    agent: row.agent,
    pipeline: row.pipeline,
    storyIndex: row.story_index,
    state: 'running',
    stateLabel: `系统辅助尝试 ${job?.attempt_count || 1}/${job?.max_attempts || 3}`,
    currentPhase: inspected ? 'investigate' : 'restore',
    stages: [
      { id: 'restore', label: '读取协助请求', status: inspected ? 'completed' : 'current' },
      { id: 'investigate', label: '自主调查与验证', status: inspected ? 'current' : 'pending' },
      { id: 'submit', label: '提交解决或转交', status: 'pending' },
    ],
    latestCommand: latestDomainCommand(db, row.execution_id),
    updatedAt: row.updated_at,
  };
}

function domainCommandEvents(rows: ToolReceiptRow[], fallbackExecutionId = '') {
  return rows.flatMap((row): DomainCommandEvent[] => {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const input = payload.input as Record<string, unknown> | undefined;
      const command = typeof input?.command === 'string' ? input.command : '';
      if (!/loop-agent\.(?:mjs|cjs)/i.test(command)) return [];
      return [{
        executionId: row.execution_id || fallbackExecutionId,
        receiptKey: row.receipt_key,
        toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : '',
        commandHash: typeof payload.commandHash === 'string' ? payload.commandHash : '',
        phase: typeof payload.phase === 'string' ? payload.phase : '',
        summary: typeof payload.summary === 'string' ? payload.summary : '',
        success: typeof payload.success === 'boolean' ? payload.success : null,
        createdAt: row.created_at,
      }];
    } catch {
      return [];
    }
  });
}

function commandIdentity(event: DomainCommandEvent) {
  return event.toolCallId || event.commandHash;
}

function domainCommandAuditRecords(rows: ToolReceiptRow[], fallbackExecutionId = '') {
  const records: AgentCommandAuditRecord[] = [];
  const activeRecords = new Map<string, AgentCommandAuditRecord>();
  const events = domainCommandEvents(rows, fallbackExecutionId);

  for (const event of events) {
    const identity = commandIdentity(event);
    const activeKey = `${event.executionId}:${identity}`;
    if (event.phase === 'started') {
      const record: AgentCommandAuditRecord = {
        executionId: event.executionId,
        id: identity ? `${activeKey}:${event.receiptKey}` : `${event.executionId}:${event.receiptKey}`,
        label: event.summary || '执行 Agent 领域命令',
        status: 'running',
        startedAt: event.createdAt,
        finishedAt: null,
      };
      records.push(record);
      if (identity) activeRecords.set(activeKey, record);
      continue;
    }

    if (event.phase !== 'completed') continue;
    const record = identity ? activeRecords.get(activeKey) : undefined;
    if (record) {
      record.status = event.success === true ? 'success' : 'error';
      record.finishedAt = event.createdAt;
      activeRecords.delete(activeKey);
      continue;
    }

    records.push({
      executionId: event.executionId,
      id: identity ? `${activeKey}:${event.receiptKey}` : `${event.executionId}:${event.receiptKey}`,
      label: '执行 Agent 领域命令',
      status: event.success === true ? 'success' : 'error',
      startedAt: event.createdAt,
      finishedAt: event.createdAt,
    });
  }
  return records;
}

function latestDomainCommand(db: Database.Database, executionId: string | null) {
  if (!executionId) return null;
  const rows = db.prepare(`
    SELECT receipt_key, payload_json, created_at
    FROM execution_receipts
    WHERE execution_id = ? AND kind = 'tool_event'
    ORDER BY receipt_key
  `).all(executionId) as ToolReceiptRow[];
  const events = domainCommandEvents(rows, executionId);
  const latest = events.at(-1);
  if (!latest) return null;
  const identity = commandIdentity(latest);
  const started = [...events].reverse().find((event) => event.phase === 'started'
    && (!identity || commandIdentity(event) === identity));
  return {
    label: started?.summary || (latest.phase === 'started' ? latest.summary : '') || '执行 Agent 领域命令',
    status: latest.phase === 'started' ? 'running' as const : latest.success === true ? 'success' as const : 'error' as const,
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
    SELECT work.draft_id, work.draft_type, work.command_chain_id, work.agent, work.status, work.change_seq,
           work.story_index, work.last_execution_id, work.status_viewed_execution_id,
           work.updated_at,
           chain.workflow_phase,
           execution.status AS execution_status, execution.pipeline
    FROM agent_work_drafts work
    LEFT JOIN command_chain_drafts chain ON chain.draft_id = work.draft_id
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
    if (execution.pipeline === 'verification-assistance') {
      progress.push(verificationAssistanceProgress(db, execution));
      continue;
    }
    const profile = agentCommandProfile(execution.agent, execution.pipeline);
    if (!profile || profile.draftType === 'direct') {
      const direct = directProgress(execution);
      direct.latestCommand = latestDomainCommand(db, execution.execution_id);
      progress.push(direct);
      continue;
    }
    const provisional: DraftProgressRow = {
      draft_id: '', draft_type: profile.draftType, command_chain_id: profile.commandChainId || null,
      agent: execution.agent, status: 'editing',
      change_seq: 0, story_index: execution.story_index, last_execution_id: execution.execution_id,
      status_viewed_execution_id: null, updated_at: execution.updated_at, workflow_phase: null,
      execution_status: execution.status, pipeline: execution.pipeline,
    };
    progress.push(buildDraftProgress(db, provisional));
  }
  return progress.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getAgentCommandProgress(taskId: string) {
  const db = await databaseConnection();
  return agentCommandProgressInDb(db, taskId);
}

export function agentCommandAuditInDb(db: Database.Database, taskId: string) {
  const rows = db.prepare(`
    SELECT receipt.execution_id, receipt.receipt_key, receipt.payload_json, receipt.created_at
    FROM execution_receipts receipt
    JOIN execution_attempts execution ON execution.execution_id = receipt.execution_id
    WHERE execution.task_id = ? AND receipt.kind = 'tool_event'
    ORDER BY execution.created_at, receipt.execution_id, receipt.receipt_key
  `).all(taskId) as ToolReceiptRow[];
  return domainCommandAuditRecords(rows);
}

export async function getAgentCommandAudit(taskId: string) {
  const db = await databaseConnection();
  return agentCommandAuditInDb(db, taskId);
}
