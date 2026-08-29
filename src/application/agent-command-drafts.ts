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
  businessAnalysisHelp,
  cloneBusinessAnalysisDraft,
  initializeBusinessAnalysisDraft,
  runBusinessAnalysisCommand,
} from './business-analysis-command-drafts';
import { directHelp, runDirectCommand } from './direct-command';
import { parseAgentCommand } from '../domain/agent-command';
import {
  cloneCommandChainDraft,
  commandChainHelp,
  initializeCommandChainDraft,
  runCommandChainCommand,
} from './command-chain-drafts';

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
  web_search_enabled: number;
};

type DraftRow = {
  draft_id: string;
  work_key: string;
  draft_version: number;
  draft_type: 'requirement_context' | 'delivery_plan' | 'reproduction' | 'analysis' | 'development' | 'verification' | 'feedback' | 'review' | 'business_analysis';
  task_id: string;
  story_index: number | null;
  agent: string;
  status: 'editing' | 'waiting_for_answers' | 'submitted' | 'abandoned';
  change_seq: number;
  last_execution_id: string | null;
  status_viewed_execution_id: string | null;
  terminal_execution_id: string | null;
  terminal_action: string | null;
  updated_at: string;
  command_chain_id: string | null;
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

function executionInDb(db: Awaited<ReturnType<typeof databaseConnection>>, executionId: string) {
  return db.prepare(`
    SELECT execution_id, task_id, story_index, agent, pipeline, delegation_key, input_json,
           status, command_token_hash, base_commit, web_search_enabled
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

export async function resetAgentCommandStatusForContinuation(executionId: string) {
  const db = await databaseConnection();
  const execution = executionInDb(db, executionId);
  if (!execution) throw new Error('当前 execution 不存在，无法准备自动续跑');
  const profile = agentCommandProfile(execution.agent, execution.pipeline);
  if (!profile) throw new Error(`${execution.agent}/${execution.pipeline} 尚未启用 Agent 命令`);
  if (profile.draftType === 'direct') return false;

  const result = db.prepare(`
    UPDATE agent_work_drafts
    SET status_viewed_execution_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE status_viewed_execution_id = ?
      AND last_execution_id = ?
      AND status = 'editing'
  `).run(executionId, executionId);
  return result.changes > 0;
}

function latestDraft(db: Awaited<ReturnType<typeof databaseConnection>>, workKey: string) {
  return db.prepare(`
    SELECT * FROM agent_work_drafts
    WHERE work_key = ?
    ORDER BY draft_version DESC
    LIMIT 1
  `).get(workKey) as DraftRow | undefined;
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
        agent, status, last_execution_id, command_chain_id
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'editing', ?, ?)
    `).run(
      draftId,
      workKey,
      version,
      profile.draftType,
      execution.task_id,
      execution.story_index,
      execution.agent,
      execution.execution_id,
      profile.commandChainId || null,
    );
    const created = db.prepare('SELECT * FROM agent_work_drafts WHERE draft_id = ?').get(draftId) as DraftRow;
    if (profile.commandChainId) {
      if (source) cloneCommandChainDraft(db, source, created);
      else initializeCommandChainDraft(db, execution, created);
    } else if (profile.draftType === 'business_analysis') {
      if (source) cloneBusinessAnalysisDraft(db, source, created, execution.agent, Boolean(execution.web_search_enabled));
      else initializeBusinessAnalysisDraft(db, created, execution.agent, Boolean(execution.web_search_enabled));
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

const LONG_TEXT_FILE_HELP = [
  '长文本参数：',
  '  长文本必须写入 $LOOP_AGENT_TMP_DIR 指向的工作区 .tmp/agent-<execution-id> 目录，再使用对应的 --*-file 参数读取 UTF-8 文件；不要自行拼接路径。',
  '  当前 execution 结束后 Harness 会清理临时目录；不要把临时文件写入源码目录或提交到 Git。',
];

function helpText(execution: ExecutionRow, profile: AgentCommandProfile, topic?: string | null) {
  const appRoot = process.env.LOOP_APP_ROOT?.trim() || '<Harness Command Root>';
  const command = loopAgentCommandPrefix(appRoot);
  if (profile.draftType === 'direct') {
    if (topic && topic !== 'context') throw new Error('Direct help 只支持 context 主题');
    return [
      `当前身份：${execution.agent} · ${execution.pipeline}`,
      '',
      ...directHelp().split('\n'),
      '',
      '只读上下文工具：',
      ...agentContextHelpLines(appRoot),
    ].join('\n');
  }
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
    if (profile.draftType === 'business_analysis') {
      return [
        `当前身份：${execution.agent} · ${execution.pipeline}`,
        `帮助主题：${topic}`,
        '',
        ...businessAnalysisHelp(execution.agent, topic),
        '',
        ...LONG_TEXT_FILE_HELP,
        `  其他主题：${command} help <context|workflow|artifact|decision|finish>`,
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
  if (profile.draftType === 'business_analysis') {
    return [
      ...common,
      ...businessAnalysisHelp(execution.agent, null),
      '',
      ...LONG_TEXT_FILE_HELP,
    ].join('\n');
  }
  throw new Error(`当前角色没有旧 namespace help：${profile.namespace}`);
}

export async function issueAgentCommandToken(executionId: string) {
  const db = await databaseConnection();
  const execution = executionInDb(db, executionId);
  const profile = execution
    ? agentCommandProfile(execution.agent, execution.pipeline)
    : null;
  if (!execution || !profile) return null;
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
      AND (
        EXISTS (
          SELECT 1 FROM agent_work_drafts
          WHERE terminal_execution_id = execution_attempts.execution_id
        )
        OR EXISTS (
          SELECT 1 FROM direct_execution_state
          WHERE execution_id = execution_attempts.execution_id AND submitted_at IS NOT NULL
        )
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
  const parsed = parseAgentCommand(input.args);
  const { positionals, flags } = parsed;
  const command = parsed.raw;

  if (parsed.kind === 'help') {
    if (profile.commandChainId && !positionals[1]) return commandChainHelp();
    if (profile.commandChainId && positionals[1] !== 'context') {
      throw new Error('通用命令链 help 只支持 context 主题；当前阶段的具体命令请执行 status');
    }
    if (positionals.length > 2) throw new Error('help 最多接受一个主题');
    if (['requirement_context', 'analysis', 'development', 'verification', 'review', 'business_analysis'].includes(profile.draftType) && !positionals[1]) {
      const topics = profile.draftType === 'requirement_context'
        ? 'context|assertion|impact|decision-proposal|decision-resolution|answer-review|scope|finish'
        : profile.draftType === 'analysis'
            ? 'context|impact|decision-proposal|decision-resolution|answer-review|contract|finish'
            : profile.draftType === 'development'
              ? 'context|evidence|review|commit|input|finish'
            : profile.draftType === 'verification'
              ? 'context|plan|execute|evidence|input|finish'
              : profile.draftType === 'business_analysis'
                ? 'context|workflow|artifact|decision|finish'
                : 'context|reconciliation|gap|assessment|report|forward|finish';
      throw new Error(
        `${profile.namespace} help 必须指定一个主题：help <${topics}>。`
        + `当前阶段可执行命令请查看 ${profile.namespace} status 返回的 AVAILABLE COMMANDS。`,
      );
    }
    return helpText(execution, profile, positionals[1] || null);
  }
  if (parsed.kind === 'identity') {
    return `${execution.agent} · ${execution.pipeline} · execution=${execution.execution_id}`;
  }
  const genericCommand = [
    'status', 'delivery-unit', 'delivery-spec', 'artifact', 'decision',
    'check', 'runtime-input', 'phase', 'draft',
  ].includes(positionals[0] || '');
  if (!genericCommand && !command.startsWith(profile.namespace)) {
    throw new Error(`当前 execution 不允许命令：${command || '(empty)'}。请使用 loop-agent help`);
  }

  if (profile.draftType === 'direct') {
    return runDirectCommand({ db, execution, command, flags });
  }

  let draft = ensureDraft(db, execution, profile, workKey);
  if (profile.commandChainId) {
    if (!genericCommand) throw new Error('当前草稿使用通用命令链，请先执行 status');
    return runCommandChainCommand({ db, execution, draft, command, positionals, flags });
  }
  if (profile.draftType === 'business_analysis') {
    return runBusinessAnalysisCommand({ db, execution, draft, command, flags });
  }
  throw new Error(`当前 execution 没有可用命令处理器：${command}`);
}

export const agentCommandDraftInternals = {
  parseArgs: parseAgentCommand,
};
