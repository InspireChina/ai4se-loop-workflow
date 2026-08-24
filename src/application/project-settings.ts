import { revalidatePath } from 'next/cache';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AGENT_EXECUTORS, type AgentExecutorId } from '../domain/agent-executor';
import { FLOW_AGENT_IDS, isFlowAgentId, type FlowAgentId } from '../domain/agent-profile';
import type { AgentExecutionOptions } from '../infrastructure/agent-executor';
import { databaseConnection, setConfiguredWorkspaceRoot } from '../infrastructure/database';
import { advanceRuntimeEventRevisionInDb, publishRuntimeInvalidation } from './runtime-events';

export const AGENT_EXECUTOR_OPTIONS: ReadonlyArray<{
  id: AgentExecutorId;
  label: string;
  description: string;
}> = [
  { id: 'cursor', label: 'Cursor', description: '使用 Cursor Agent CLI 执行每个推进步骤。' },
  { id: 'codex', label: 'Codex', description: '使用 Codex CLI 的非交互 JSON 模式执行。' },
  { id: 'claude', label: 'Claude', description: '使用 Claude Code CLI 的流式 JSON 模式执行。' },
  { id: 'omp', label: 'Oh My Pi', description: '使用 OMP CLI 的 JSON 模式，可覆盖模型与思考强度。' },
];

const executorSchema = z.enum(AGENT_EXECUTORS);
const workspaceRootSchema = z.string().trim().min(1, '请输入工作区根目录');
export const CODEX_REASONING_EFFORTS = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];
export const CODEX_MODEL_OPTIONS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: '最高智能，适合复杂分析与开发任务。' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: '平衡智能、速度与成本。' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: '优先低成本，适合更轻量的任务。' },
] as const;
export type CodexModel = typeof CODEX_MODEL_OPTIONS[number]['id'];
export const DEFAULT_CODEX_MODEL: CodexModel = 'gpt-5.6-sol';
export const DEFAULT_CLAUDE_MODEL = '';
export const DEFAULT_OMP_MODEL = '';
export const OMP_THINKING_LEVELS = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
export type OmpThinkingLevel = typeof OMP_THINKING_LEVELS[number];
const codexModelSchema = z.enum(CODEX_MODEL_OPTIONS.map((option) => option.id) as [CodexModel, ...CodexModel[]]);
const codexReasoningEffortSchema = z.enum(CODEX_REASONING_EFFORTS);
const claudeModelSchema = z.string().trim().max(200, 'Claude 模型名称不能超过 200 个字符').regex(/^[^\u0000-\u001f\u007f]*$/, 'Claude 模型名称包含无效控制字符');
const ompModelSchema = z.string().trim().max(200, 'OMP 模型名称不能超过 200 个字符').regex(/^[^\u0000-\u001f\u007f]*$/, 'OMP 模型名称包含无效控制字符');
const ompThinkingSchema = z.enum(OMP_THINKING_LEVELS);
const langfuseSampleRateSchema = z.coerce.number().min(0, '采样率不能小于 0').max(1, '采样率不能大于 1');
export const DEFAULT_AGENT_CONCURRENCY = 4;
export const MAX_AGENT_CONCURRENCY = 32;
const agentConcurrencySchema = z.coerce.number().int('Agent 并发数必须是整数')
  .min(1, 'Agent 并发数不能小于 1')
  .max(MAX_AGENT_CONCURRENCY, `Agent 并发数不能大于 ${MAX_AGENT_CONCURRENCY}`);

const LANGFUSE_SETTING_KEYS = [
  'langfuse_enabled',
  'langfuse_public_key',
  'langfuse_secret_key',
  'langfuse_base_url',
  'langfuse_sample_rate',
  'langfuse_capture_prompts',
] as const;

export type AgentExecutorSettings = {
  executorId: AgentExecutorId;
  codexModel: CodexModel;
  codexReasoningEffort: CodexReasoningEffort;
  codexWebSearch: boolean;
  claudeModel: string;
  ompModel: string;
  ompThinking: OmpThinkingLevel;
};

export type AgentRuntimeSettings = AgentExecutorSettings & {
  agentId: FlowAgentId;
  source: 'project_default' | 'agent_override';
};

type AgentRuntimeSettingsRow = {
  agent_id: string;
  executor_id: string;
  codex_model: string;
  codex_reasoning_effort: string;
  codex_web_search: number;
  claude_model: string;
  omp_model: string;
  omp_thinking: string;
};

export type LangfuseSettings = {
  enabled: boolean;
  publicKey: string;
  hasSecretKey: boolean;
  baseUrl: string;
  sampleRate: number;
  capturePrompts: boolean;
  source: 'project' | 'environment';
  status: 'enabled' | 'disabled' | 'incomplete' | 'invalid';
  statusMessage: string;
};

function enabledFlag(value: string | undefined) {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '');
}

function validUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function langfuseStatus(settings: Pick<LangfuseSettings, 'enabled' | 'publicKey' | 'hasSecretKey' | 'baseUrl' | 'sampleRate'>) {
  if (!settings.enabled) return { status: 'disabled' as const, statusMessage: '未启用，不会创建 Langfuse trace。' };
  if (!settings.publicKey || !settings.hasSecretKey || !settings.baseUrl) {
    return { status: 'incomplete' as const, statusMessage: '已启用但缺少 public key、secret key 或 base URL。' };
  }
  if (!validUrl(settings.baseUrl)) return { status: 'invalid' as const, statusMessage: 'Base URL 格式无效。' };
  if (!Number.isFinite(settings.sampleRate) || settings.sampleRate < 0 || settings.sampleRate > 1) {
    return { status: 'invalid' as const, statusMessage: '采样率必须在 0 到 1 之间。' };
  }
  return { status: 'enabled' as const, statusMessage: '已启用；新的 Agent 执行会创建按 flow 命名的 Langfuse trace。' };
}

async function readProjectSettings(keys: readonly string[]) {
  const db = await databaseConnection();
  const placeholders = keys.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT setting_key, setting_value FROM project_settings WHERE setting_key IN (${placeholders})`).all(...keys) as { setting_key: string; setting_value: string }[];
  return Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
}

export function agentConcurrencyInDb(db: Awaited<ReturnType<typeof databaseConnection>>) {
  const row = db.prepare(`
    SELECT setting_value FROM project_settings WHERE setting_key = 'agent_concurrency'
  `).get() as { setting_value: string } | undefined;
  const parsed = agentConcurrencySchema.safeParse(row?.setting_value);
  return parsed.success ? parsed.data : DEFAULT_AGENT_CONCURRENCY;
}

export async function getAgentConcurrency() {
  const db = await databaseConnection();
  return agentConcurrencyInDb(db);
}

export async function setAgentConcurrency(input: unknown) {
  const concurrency = agentConcurrencySchema.parse(input);
  const db = await databaseConnection();
  const revision = db.transaction(() => {
    db.prepare(`
      INSERT INTO project_settings(setting_key, setting_value)
      VALUES('agent_concurrency', ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = CURRENT_TIMESTAMP
    `).run(String(concurrency));
    return advanceRuntimeEventRevisionInDb(db, 'dispatch.invalidated');
  })();
  await publishRuntimeInvalidation('dispatch.invalidated', revision, 'agent-concurrency');
  try { revalidatePath('/settings'); } catch { /* CLI usage has no request context. */ }
  return concurrency;
}

export function normalizeWorkspaceRoot(input: unknown) {
  const requested = resolve(workspaceRootSchema.parse(input));
  let root: string;
  try { root = realpathSync(requested); }
  catch { throw new Error(`工作区根目录不存在：${requested}`); }
  if (!statSync(root).isDirectory()) throw new Error(`工作区根目录不是文件夹：${root}`);
  return root;
}

export function setWorkspaceRoot(input: unknown) {
  const root = normalizeWorkspaceRoot(input);
  setConfiguredWorkspaceRoot(root);
  try { revalidatePath('/', 'layout'); } catch { /* CLI usage has no request context. */ }
  return root;
}

export async function getAgentExecutorId(): Promise<AgentExecutorId> {
  return (await getAgentExecutorSettings()).executorId;
}

export async function getAgentExecutorSettings(): Promise<AgentExecutorSettings> {
  const settings = await readProjectSettings(['agent_executor', 'codex_model', 'codex_reasoning_effort', 'codex_web_search', 'claude_model', 'omp_model', 'omp_thinking']);
  const executor = executorSchema.safeParse(settings.agent_executor);
  const model = codexModelSchema.safeParse(settings.codex_model);
  const effort = codexReasoningEffortSchema.safeParse(settings.codex_reasoning_effort);
  const claudeModel = claudeModelSchema.safeParse(settings.claude_model ?? DEFAULT_CLAUDE_MODEL);
  const ompModel = ompModelSchema.safeParse(settings.omp_model ?? DEFAULT_OMP_MODEL);
  const ompThinking = ompThinkingSchema.safeParse(settings.omp_thinking ?? 'default');
  return {
    executorId: executor.success ? executor.data : 'cursor',
    codexModel: model.success ? model.data : DEFAULT_CODEX_MODEL,
    codexReasoningEffort: effort.success ? effort.data : 'default',
    codexWebSearch: settings.codex_web_search === undefined ? true : enabledFlag(settings.codex_web_search),
    claudeModel: claudeModel.success ? claudeModel.data : DEFAULT_CLAUDE_MODEL,
    ompModel: ompModel.success ? ompModel.data : DEFAULT_OMP_MODEL,
    ompThinking: ompThinking.success ? ompThinking.data : 'default',
  };
}

function parseAgentRuntimeSettings(row: AgentRuntimeSettingsRow | undefined, agentId: FlowAgentId, fallback: AgentExecutorSettings): AgentRuntimeSettings {
  const executor = executorSchema.safeParse(row?.executor_id);
  const model = codexModelSchema.safeParse(row?.codex_model);
  const effort = codexReasoningEffortSchema.safeParse(row?.codex_reasoning_effort);
  const claudeModel = claudeModelSchema.safeParse(row?.claude_model ?? fallback.claudeModel);
  const ompModel = ompModelSchema.safeParse(row?.omp_model ?? fallback.ompModel);
  const ompThinking = ompThinkingSchema.safeParse(row?.omp_thinking ?? fallback.ompThinking);
  return {
    agentId,
    executorId: executor.success ? executor.data : fallback.executorId,
    codexModel: model.success ? model.data : fallback.codexModel,
    codexReasoningEffort: effort.success ? effort.data : fallback.codexReasoningEffort,
    codexWebSearch: row ? Boolean(row.codex_web_search) : fallback.codexWebSearch,
    claudeModel: claudeModel.success ? claudeModel.data : fallback.claudeModel,
    ompModel: ompModel.success ? ompModel.data : fallback.ompModel,
    ompThinking: ompThinking.success ? ompThinking.data : fallback.ompThinking,
    source: row ? 'agent_override' : 'project_default',
  };
}

export async function getFlowAgentDefaultRuntimeSettings(): Promise<AgentExecutorSettings> {
  const settings = await readProjectSettings([
    'flow_agent_executor', 'flow_codex_model', 'flow_codex_reasoning_effort',
    'flow_codex_web_search', 'flow_claude_model', 'flow_omp_model', 'flow_omp_thinking',
  ]);
  const systemFallback = await getAgentExecutorSettings();
  const executor = executorSchema.safeParse(settings.flow_agent_executor);
  const model = codexModelSchema.safeParse(settings.flow_codex_model);
  const effort = codexReasoningEffortSchema.safeParse(settings.flow_codex_reasoning_effort);
  const claudeModel = claudeModelSchema.safeParse(settings.flow_claude_model ?? systemFallback.claudeModel);
  const ompModel = ompModelSchema.safeParse(settings.flow_omp_model ?? systemFallback.ompModel);
  const ompThinking = ompThinkingSchema.safeParse(settings.flow_omp_thinking ?? systemFallback.ompThinking);
  return {
    executorId: executor.success ? executor.data : systemFallback.executorId,
    codexModel: model.success ? model.data : systemFallback.codexModel,
    codexReasoningEffort: effort.success ? effort.data : systemFallback.codexReasoningEffort,
    codexWebSearch: settings.flow_codex_web_search === undefined ? true : enabledFlag(settings.flow_codex_web_search),
    claudeModel: claudeModel.success ? claudeModel.data : systemFallback.claudeModel,
    ompModel: ompModel.success ? ompModel.data : systemFallback.ompModel,
    ompThinking: ompThinking.success ? ompThinking.data : systemFallback.ompThinking,
  };
}

export async function getAgentRuntimeSettings(agentIdInput: string): Promise<AgentRuntimeSettings> {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  const [db, fallback] = await Promise.all([databaseConnection(), getFlowAgentDefaultRuntimeSettings()]);
  const row = db.prepare('SELECT * FROM agent_runtime_settings WHERE agent_id = ?').get(agentIdInput) as AgentRuntimeSettingsRow | undefined;
  return parseAgentRuntimeSettings(row, agentIdInput, fallback);
}

export async function listAgentRuntimeSettings(): Promise<AgentRuntimeSettings[]> {
  const [db, fallback] = await Promise.all([databaseConnection(), getFlowAgentDefaultRuntimeSettings()]);
  const rows = db.prepare('SELECT * FROM agent_runtime_settings').all() as AgentRuntimeSettingsRow[];
  const byAgent = new Map(rows.map((row) => [row.agent_id, row]));
  return FLOW_AGENT_IDS.map((agentId) => parseAgentRuntimeSettings(byAgent.get(agentId), agentId, fallback));
}

export async function setAgentRuntimeSettings(agentIdInput: string, input: { inheritProjectDefault?: unknown; executorId?: unknown; codexModel?: unknown; codexReasoningEffort?: unknown; codexWebSearch?: unknown; claudeModel?: unknown; ompModel?: unknown; ompThinking?: unknown }) {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  const inheritProjectDefault = input.inheritProjectDefault === true || input.inheritProjectDefault === 'on' || input.inheritProjectDefault === 'true';
  const db = await databaseConnection();
  if (inheritProjectDefault) {
    db.prepare('DELETE FROM agent_runtime_settings WHERE agent_id = ?').run(agentIdInput);
    try {
      revalidatePath('/agents');
      revalidatePath(`/agents/${agentIdInput}`);
    } catch { /* CLI usage has no request context. */ }
    return getAgentRuntimeSettings(agentIdInput);
  }
  const executorId = executorSchema.parse(input.executorId);
  const codexModel = codexModelSchema.parse(input.codexModel ?? DEFAULT_CODEX_MODEL);
  const codexReasoningEffort = codexReasoningEffortSchema.parse(input.codexReasoningEffort ?? 'default');
  const codexWebSearch = input.codexWebSearch === true || input.codexWebSearch === 'on' || input.codexWebSearch === 'true';
  const claudeModel = claudeModelSchema.parse(input.claudeModel ?? DEFAULT_CLAUDE_MODEL);
  const ompModel = ompModelSchema.parse(input.ompModel ?? DEFAULT_OMP_MODEL);
  const ompThinking = ompThinkingSchema.parse(input.ompThinking ?? 'default');
  db.prepare(`
    INSERT INTO agent_runtime_settings(
      agent_id, executor_id, codex_model, codex_reasoning_effort, codex_web_search, claude_model,
      omp_model, omp_thinking
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      executor_id = excluded.executor_id,
      codex_model = excluded.codex_model,
      codex_reasoning_effort = excluded.codex_reasoning_effort,
      codex_web_search = excluded.codex_web_search,
      claude_model = excluded.claude_model,
      omp_model = excluded.omp_model,
      omp_thinking = excluded.omp_thinking,
      updated_at = CURRENT_TIMESTAMP
  `).run(agentIdInput, executorId, codexModel, codexReasoningEffort, codexWebSearch ? 1 : 0, claudeModel, ompModel, ompThinking);
  try {
    revalidatePath('/agents');
    revalidatePath(`/agents/${agentIdInput}`);
  } catch { /* CLI usage has no request context. */ }
  return { agentId: agentIdInput, executorId, codexModel, codexReasoningEffort, codexWebSearch, claudeModel, ompModel, ompThinking, source: 'agent_override' } satisfies AgentRuntimeSettings;
}

export async function setAgentExecutorSettings(input: { executorId: unknown; codexModel?: unknown; codexReasoningEffort?: unknown; codexWebSearch?: unknown; claudeModel?: unknown; ompModel?: unknown; ompThinking?: unknown }) {
  const executorId = executorSchema.parse(input.executorId);
  const codexModel = codexModelSchema.parse(input.codexModel ?? DEFAULT_CODEX_MODEL);
  const codexReasoningEffort = codexReasoningEffortSchema.parse(input.codexReasoningEffort ?? 'default');
  const codexWebSearch = input.codexWebSearch === true || input.codexWebSearch === 'on' || input.codexWebSearch === 'true';
  const claudeModel = claudeModelSchema.parse(input.claudeModel ?? DEFAULT_CLAUDE_MODEL);
  const ompModel = ompModelSchema.parse(input.ompModel ?? DEFAULT_OMP_MODEL);
  const ompThinking = ompThinkingSchema.parse(input.ompThinking ?? 'default');
  const db = await databaseConnection();
  const upsert = db.prepare(`INSERT INTO project_settings(setting_key, setting_value) VALUES(?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`);
  db.transaction(() => {
    upsert.run('agent_executor', executorId);
    upsert.run('codex_model', codexModel);
    upsert.run('codex_reasoning_effort', codexReasoningEffort);
    upsert.run('codex_web_search', codexWebSearch ? 'true' : 'false');
    upsert.run('claude_model', claudeModel);
    upsert.run('omp_model', ompModel);
    upsert.run('omp_thinking', ompThinking);
  })();
  try { revalidatePath('/settings'); } catch { /* CLI usage has no request context. */ }
  return { executorId, codexModel, codexReasoningEffort, codexWebSearch, claudeModel, ompModel, ompThinking };
}

export async function setFlowAgentDefaultRuntimeSettings(input: { executorId: unknown; codexModel?: unknown; codexReasoningEffort?: unknown; codexWebSearch?: unknown; claudeModel?: unknown; ompModel?: unknown; ompThinking?: unknown }) {
  const executorId = executorSchema.parse(input.executorId);
  const codexModel = codexModelSchema.parse(input.codexModel ?? DEFAULT_CODEX_MODEL);
  const codexReasoningEffort = codexReasoningEffortSchema.parse(input.codexReasoningEffort ?? 'default');
  const codexWebSearch = input.codexWebSearch === true || input.codexWebSearch === 'on' || input.codexWebSearch === 'true';
  const claudeModel = claudeModelSchema.parse(input.claudeModel ?? DEFAULT_CLAUDE_MODEL);
  const ompModel = ompModelSchema.parse(input.ompModel ?? DEFAULT_OMP_MODEL);
  const ompThinking = ompThinkingSchema.parse(input.ompThinking ?? 'default');
  const db = await databaseConnection();
  const upsert = db.prepare(`INSERT INTO project_settings(setting_key, setting_value) VALUES(?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`);
  db.transaction(() => {
    upsert.run('flow_agent_executor', executorId);
    upsert.run('flow_codex_model', codexModel);
    upsert.run('flow_codex_reasoning_effort', codexReasoningEffort);
    upsert.run('flow_codex_web_search', codexWebSearch ? 'true' : 'false');
    upsert.run('flow_claude_model', claudeModel);
    upsert.run('flow_omp_model', ompModel);
    upsert.run('flow_omp_thinking', ompThinking);
  })();
  try {
    revalidatePath('/settings');
    revalidatePath('/agents');
  } catch { /* CLI usage has no request context. */ }
  return { executorId, codexModel, codexReasoningEffort, codexWebSearch, claudeModel, ompModel, ompThinking } satisfies AgentExecutorSettings;
}

export async function setAgentExecutorId(input: unknown) {
  const current = await getAgentExecutorSettings();
  return setAgentExecutorSettings({ ...current, executorId: input });
}

export function agentExecutionOptions(settings: AgentExecutorSettings): AgentExecutionOptions {
  if (settings.executorId === 'codex') return {
    model: settings.codexModel || undefined,
    reasoningEffort: settings.codexReasoningEffort === 'default' ? undefined : settings.codexReasoningEffort,
    webSearch: settings.codexWebSearch || undefined,
  };
  if (settings.executorId === 'claude') return settings.claudeModel ? { model: settings.claudeModel } : {};
  if (settings.executorId === 'omp') return {
    model: settings.ompModel || undefined,
    reasoningEffort: settings.ompThinking === 'default' ? undefined : settings.ompThinking,
  };
  return {};
}

export async function getLangfuseSettings(): Promise<LangfuseSettings> {
  const project = await readProjectSettings(LANGFUSE_SETTING_KEYS);
  const hasProjectSettings = LANGFUSE_SETTING_KEYS.some((key) => project[key] !== undefined);
  const source = hasProjectSettings ? 'project' as const : 'environment' as const;
  const env = process.env;
  const enabled = hasProjectSettings ? enabledFlag(project.langfuse_enabled) : enabledFlag(env.LANGFUSE_ENABLED);
  const publicKey = (hasProjectSettings ? project.langfuse_public_key : env.LANGFUSE_PUBLIC_KEY)?.trim() ?? '';
  const secretKey = (hasProjectSettings ? project.langfuse_secret_key : env.LANGFUSE_SECRET_KEY)?.trim() ?? '';
  const baseUrl = (hasProjectSettings ? project.langfuse_base_url : env.LANGFUSE_BASE_URL)?.trim() || 'https://cloud.langfuse.com';
  const parsedSampleRate = Number((hasProjectSettings ? project.langfuse_sample_rate : env.LANGFUSE_SAMPLE_RATE) ?? '1');
  const sampleRate = Number.isFinite(parsedSampleRate) ? parsedSampleRate : 1;
  const capturePrompts = hasProjectSettings ? enabledFlag(project.langfuse_capture_prompts) : enabledFlag(env.LANGFUSE_CAPTURE_PROMPTS);
  const status = langfuseStatus({ enabled, publicKey, hasSecretKey: Boolean(secretKey), baseUrl, sampleRate });
  return {
    enabled,
    publicKey,
    hasSecretKey: Boolean(secretKey),
    baseUrl,
    sampleRate,
    capturePrompts,
    source,
    ...status,
  };
}

export async function getLangfuseRuntimeEnv(): Promise<NodeJS.ProcessEnv> {
  const settings = await getLangfuseSettings();
  const project = await readProjectSettings(LANGFUSE_SETTING_KEYS);
  const hasProjectSettings = LANGFUSE_SETTING_KEYS.some((key) => project[key] !== undefined);
  if (!hasProjectSettings) return process.env;
  return {
    ...process.env,
    LANGFUSE_ENABLED: settings.enabled ? 'true' : 'false',
    LANGFUSE_PUBLIC_KEY: settings.publicKey,
    LANGFUSE_SECRET_KEY: project.langfuse_secret_key ?? '',
    LANGFUSE_BASE_URL: settings.baseUrl,
    LANGFUSE_SAMPLE_RATE: String(settings.sampleRate),
    LANGFUSE_CAPTURE_PROMPTS: settings.capturePrompts ? 'true' : 'false',
  };
}

export async function setLangfuseSettings(input: {
  enabled: unknown;
  publicKey?: unknown;
  secretKey?: unknown;
  baseUrl?: unknown;
  sampleRate?: unknown;
  capturePrompts: unknown;
}) {
  const currentProject = await readProjectSettings(LANGFUSE_SETTING_KEYS);
  const enabled = input.enabled === true || input.enabled === 'on' || input.enabled === 'true';
  const publicKey = z.string().trim().parse(input.publicKey ?? '');
  const nextSecretKey = z.string().trim().parse(input.secretKey ?? '');
  const secretKey = nextSecretKey || currentProject.langfuse_secret_key || '';
  const baseUrl = z.string().trim().parse(input.baseUrl ?? 'https://cloud.langfuse.com') || 'https://cloud.langfuse.com';
  const sampleRate = langfuseSampleRateSchema.parse(input.sampleRate ?? 1);
  const capturePrompts = input.capturePrompts === true || input.capturePrompts === 'on' || input.capturePrompts === 'true';
  const status = langfuseStatus({ enabled, publicKey, hasSecretKey: Boolean(secretKey), baseUrl, sampleRate });
  if (enabled && status.status !== 'enabled') throw new Error(status.statusMessage);

  const db = await databaseConnection();
  const upsert = db.prepare(`INSERT INTO project_settings(setting_key, setting_value) VALUES(?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`);
  db.transaction(() => {
    upsert.run('langfuse_enabled', enabled ? 'true' : 'false');
    upsert.run('langfuse_public_key', publicKey);
    upsert.run('langfuse_secret_key', secretKey);
    upsert.run('langfuse_base_url', baseUrl);
    upsert.run('langfuse_sample_rate', String(sampleRate));
    upsert.run('langfuse_capture_prompts', capturePrompts ? 'true' : 'false');
  })();
  try { revalidatePath('/settings'); } catch { /* CLI usage has no request context. */ }
  return getLangfuseSettings();
}
