import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AGENT_EXECUTORS, type AgentExecutorId } from '../domain/agent-executor';
import { FLOW_AGENT_IDS, isFlowAgentId, type FlowAgentId } from '../domain/agent-profile';
import type { AgentExecutionOptions } from '../infrastructure/agent-executor';
import { appDatabaseConnection, databaseConnection, setConfiguredWorkspaceRoot } from '../infrastructure/database';
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
  source: 'global_default' | 'agent_configuration';
  configurationId: string;
  configurationName: string;
};

export type GlobalRuntimeConfiguration = AgentExecutorSettings & {
  configurationId: string;
  scope: 'system' | 'flow' | 'agent';
  agentId: FlowAgentId | null;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type GlobalRuntimeConfigurationRow = {
  configuration_id: string;
  scope: GlobalRuntimeConfiguration['scope'];
  agent_id: FlowAgentId | null;
  name: string;
  is_active: number;
  executor_id: string;
  codex_model: string;
  codex_reasoning_effort: string;
  codex_web_search: number;
  claude_model: string;
  omp_model: string;
  omp_thinking: string;
  created_at: string;
  updated_at: string;
};

const runtimeConfigurationNameSchema = z.string().trim().min(1, '配置名称不能为空').max(80, '配置名称不能超过 80 个字符');
let globalRuntimeSeedsEnsured = false;

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

type RuntimeSettingsInput = {
  executorId?: unknown;
  codexModel?: unknown;
  codexReasoningEffort?: unknown;
  codexWebSearch?: unknown;
  claudeModel?: unknown;
  ompModel?: unknown;
  ompThinking?: unknown;
};

function parseExecutorSettingsInput(input: RuntimeSettingsInput): AgentExecutorSettings {
  return {
    executorId: executorSchema.parse(input.executorId),
    codexModel: codexModelSchema.parse(input.codexModel ?? DEFAULT_CODEX_MODEL),
    codexReasoningEffort: codexReasoningEffortSchema.parse(input.codexReasoningEffort ?? 'default'),
    codexWebSearch: input.codexWebSearch === true || input.codexWebSearch === 'on' || input.codexWebSearch === 'true',
    claudeModel: claudeModelSchema.parse(input.claudeModel ?? DEFAULT_CLAUDE_MODEL),
    ompModel: ompModelSchema.parse(input.ompModel ?? DEFAULT_OMP_MODEL),
    ompThinking: ompThinkingSchema.parse(input.ompThinking ?? 'default'),
  };
}

function runtimeConfigurationFromRow(row: GlobalRuntimeConfigurationRow): GlobalRuntimeConfiguration {
  const executor = executorSchema.safeParse(row.executor_id);
  const model = codexModelSchema.safeParse(row.codex_model);
  const effort = codexReasoningEffortSchema.safeParse(row.codex_reasoning_effort);
  const claudeModel = claudeModelSchema.safeParse(row.claude_model);
  const ompModel = ompModelSchema.safeParse(row.omp_model);
  const ompThinking = ompThinkingSchema.safeParse(row.omp_thinking);
  return {
    configurationId: row.configuration_id,
    scope: row.scope,
    agentId: row.agent_id,
    name: row.name,
    active: Boolean(row.is_active),
    executorId: executor.success ? executor.data : 'cursor',
    codexModel: model.success ? model.data : DEFAULT_CODEX_MODEL,
    codexReasoningEffort: effort.success ? effort.data : 'default',
    codexWebSearch: Boolean(row.codex_web_search),
    claudeModel: claudeModel.success ? claudeModel.data : DEFAULT_CLAUDE_MODEL,
    ompModel: ompModel.success ? ompModel.data : DEFAULT_OMP_MODEL,
    ompThinking: ompThinking.success ? ompThinking.data : 'default',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureGlobalRuntimeConfigurationSeeds() {
  if (globalRuntimeSeedsEnsured) return;
  const db = appDatabaseConnection();
  db.transaction(() => {
    for (const scope of ['system', 'flow'] as const) {
      let active = db.prepare(`
        SELECT configuration_id FROM global_runtime_configurations
        WHERE scope = ? AND agent_id IS NULL AND is_active = 1
      `).get(scope) as { configuration_id: string } | undefined;
      if (!active) {
        const existing = db.prepare(`
          SELECT configuration_id FROM global_runtime_configurations
          WHERE scope = ? AND agent_id IS NULL ORDER BY created_at, configuration_id LIMIT 1
        `).get(scope) as { configuration_id: string } | undefined;
        if (existing) {
          db.prepare(`UPDATE global_runtime_configurations SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE configuration_id = ?`).run(existing.configuration_id);
          active = existing;
        } else {
          const configurationId = `builtin-${scope}-runtime-default`;
          db.prepare(`
            INSERT OR IGNORE INTO global_runtime_configurations(
              configuration_id, scope, agent_id, name, is_active, executor_id,
              codex_model, codex_reasoning_effort, codex_web_search,
              claude_model, omp_model, omp_thinking
            ) VALUES(?, ?, NULL, ?, 1, 'cursor', ?, 'default', 1, '', '', 'default')
          `).run(configurationId, scope, scope === 'system' ? '系统辅助默认' : '流程 Agent 默认', DEFAULT_CODEX_MODEL);
          active = { configuration_id: configurationId };
        }
      }
    }
  })();
  globalRuntimeSeedsEnsured = true;
}

function runtimeConfigurations(scope: GlobalRuntimeConfiguration['scope'], agentId: FlowAgentId | null) {
  ensureGlobalRuntimeConfigurationSeeds();
  const rows = appDatabaseConnection().prepare(`
    SELECT * FROM global_runtime_configurations
    WHERE scope = ? AND agent_id IS ?
    ORDER BY is_active DESC, updated_at DESC, name
  `).all(scope, agentId) as GlobalRuntimeConfigurationRow[];
  return rows.map(runtimeConfigurationFromRow);
}

function activeRuntimeConfiguration(scope: GlobalRuntimeConfiguration['scope'], agentId: FlowAgentId | null) {
  return runtimeConfigurations(scope, agentId).find((configuration) => configuration.active) || null;
}

async function invalidateGlobalRuntime(reason: string, agentId?: FlowAgentId) {
  const db = await databaseConnection();
  const revision = advanceRuntimeEventRevisionInDb(db, 'dispatch.invalidated');
  await publishRuntimeInvalidation('dispatch.invalidated', revision, reason);
  try {
    revalidatePath('/settings');
    revalidatePath('/agents');
    if (agentId) revalidatePath(`/agents/${agentId}`);
  } catch { /* CLI usage has no request context. */ }
}

export function listAgentRuntimeConfigurations(agentIdInput: string) {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  return runtimeConfigurations('agent', agentIdInput);
}

export async function createAgentRuntimeConfiguration(input: {
  agentId: string;
  name: unknown;
  fromConfigurationId?: unknown;
}) {
  if (!isFlowAgentId(input.agentId)) throw new Error(`未知 Agent：${input.agentId}`);
  const name = runtimeConfigurationNameSchema.parse(input.name);
  const sourceId = String(input.fromConfigurationId || '');
  const source = sourceId
    ? listAgentRuntimeConfigurations(input.agentId).find((configuration) => configuration.configurationId === sourceId)
    : null;
  const settings = source || await getAgentRuntimeSettings(input.agentId);
  const configurationId = randomUUID();
  appDatabaseConnection().prepare(`
    INSERT INTO global_runtime_configurations(
      configuration_id, scope, agent_id, name, is_active, executor_id,
      codex_model, codex_reasoning_effort, codex_web_search, claude_model, omp_model, omp_thinking
    ) VALUES(?, 'agent', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    configurationId, input.agentId, name, settings.executorId, settings.codexModel,
    settings.codexReasoningEffort, settings.codexWebSearch ? 1 : 0,
    settings.claudeModel, settings.ompModel, settings.ompThinking,
  );
  await invalidateGlobalRuntime('global-agent-runtime-created', input.agentId);
  return configurationId;
}

export async function saveAgentRuntimeConfiguration(input: RuntimeSettingsInput & {
  agentId: string;
  configurationId: unknown;
  name: unknown;
}) {
  if (!isFlowAgentId(input.agentId)) throw new Error(`未知 Agent：${input.agentId}`);
  const name = runtimeConfigurationNameSchema.parse(input.name);
  const settings = parseExecutorSettingsInput(input);
  const result = appDatabaseConnection().prepare(`
    UPDATE global_runtime_configurations
    SET name = ?, executor_id = ?, codex_model = ?, codex_reasoning_effort = ?,
        codex_web_search = ?, claude_model = ?, omp_model = ?, omp_thinking = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE configuration_id = ? AND scope = 'agent' AND agent_id = ?
  `).run(
    name, settings.executorId, settings.codexModel, settings.codexReasoningEffort,
    settings.codexWebSearch ? 1 : 0, settings.claudeModel, settings.ompModel,
    settings.ompThinking, String(input.configurationId), input.agentId,
  );
  if (!result.changes) throw new Error('Runtime 配置不存在');
  await invalidateGlobalRuntime('global-agent-runtime-saved', input.agentId);
}

export async function activateAgentRuntimeConfiguration(input: { agentId: string; configurationId: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error(`未知 Agent：${input.agentId}`);
  const configurationId = String(input.configurationId);
  const db = appDatabaseConnection();
  db.transaction(() => {
    const exists = db.prepare(`
      SELECT 1 FROM global_runtime_configurations
      WHERE configuration_id = ? AND scope = 'agent' AND agent_id = ?
    `).get(configurationId, input.agentId);
    if (!exists) throw new Error('Runtime 配置不存在');
    db.prepare(`UPDATE global_runtime_configurations SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE scope = 'agent' AND agent_id = ?`).run(input.agentId);
    db.prepare(`UPDATE global_runtime_configurations SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE configuration_id = ?`).run(configurationId);
  })();
  await invalidateGlobalRuntime('global-agent-runtime-activated', input.agentId);
}

export async function inheritFlowRuntimeConfiguration(agentIdInput: string) {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  appDatabaseConnection().prepare(`
    UPDATE global_runtime_configurations SET is_active = 0, updated_at = CURRENT_TIMESTAMP
    WHERE scope = 'agent' AND agent_id = ?
  `).run(agentIdInput);
  await invalidateGlobalRuntime('global-agent-runtime-inherited', agentIdInput);
}

export async function deleteAgentRuntimeConfiguration(input: { agentId: string; configurationId: unknown }) {
  if (!isFlowAgentId(input.agentId)) throw new Error(`未知 Agent：${input.agentId}`);
  const db = appDatabaseConnection();
  const row = db.prepare(`
    SELECT is_active FROM global_runtime_configurations
    WHERE configuration_id = ? AND scope = 'agent' AND agent_id = ?
  `).get(String(input.configurationId), input.agentId) as { is_active: number } | undefined;
  if (!row) throw new Error('Runtime 配置不存在');
  if (row.is_active) throw new Error('不能删除当前生效 Runtime 配置');
  db.prepare(`DELETE FROM global_runtime_configurations WHERE configuration_id = ?`).run(String(input.configurationId));
  await invalidateGlobalRuntime('global-agent-runtime-deleted', input.agentId);
}

export async function getAgentExecutorId(): Promise<AgentExecutorId> {
  return (await getAgentExecutorSettings()).executorId;
}

export async function getAgentExecutorSettings(): Promise<AgentExecutorSettings> {
  const active = activeRuntimeConfiguration('system', null);
  if (!active) throw new Error('系统辅助 Runtime 配置不存在');
  return active;
}

export async function getFlowAgentDefaultRuntimeSettings(): Promise<GlobalRuntimeConfiguration> {
  const active = activeRuntimeConfiguration('flow', null);
  if (!active) throw new Error('流程 Agent 默认 Runtime 配置不存在');
  return active;
}

export async function getAgentRuntimeSettings(agentIdInput: string): Promise<AgentRuntimeSettings> {
  if (!isFlowAgentId(agentIdInput)) throw new Error(`未知 Agent：${agentIdInput}`);
  const selected = activeRuntimeConfiguration('agent', agentIdInput);
  const effective = selected || await getFlowAgentDefaultRuntimeSettings();
  return {
    agentId: agentIdInput,
    executorId: effective.executorId,
    codexModel: effective.codexModel,
    codexReasoningEffort: effective.codexReasoningEffort,
    codexWebSearch: effective.codexWebSearch,
    claudeModel: effective.claudeModel,
    ompModel: effective.ompModel,
    ompThinking: effective.ompThinking,
    source: selected ? 'agent_configuration' : 'global_default',
    configurationId: effective.configurationId,
    configurationName: effective.name,
  };
}

export async function listAgentRuntimeSettings(): Promise<AgentRuntimeSettings[]> {
  return Promise.all(FLOW_AGENT_IDS.map((agentId) => getAgentRuntimeSettings(agentId)));
}

async function saveScopedRuntimeConfiguration(scope: 'system' | 'flow', input: RuntimeSettingsInput) {
  const settings = parseExecutorSettingsInput(input);
  const current = activeRuntimeConfiguration(scope, null);
  if (!current) throw new Error('全局 Runtime 配置不存在');
  appDatabaseConnection().prepare(`
    UPDATE global_runtime_configurations
    SET executor_id = ?, codex_model = ?, codex_reasoning_effort = ?,
        codex_web_search = ?, claude_model = ?, omp_model = ?, omp_thinking = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE configuration_id = ?
  `).run(
    settings.executorId, settings.codexModel, settings.codexReasoningEffort,
    settings.codexWebSearch ? 1 : 0, settings.claudeModel, settings.ompModel,
    settings.ompThinking, current.configurationId,
  );
  await invalidateGlobalRuntime(`global-${scope}-runtime-saved`);
  return settings;
}

export async function setAgentExecutorSettings(input: RuntimeSettingsInput) {
  return saveScopedRuntimeConfiguration('system', input);
}

export async function setFlowAgentDefaultRuntimeSettings(input: RuntimeSettingsInput) {
  return saveScopedRuntimeConfiguration('flow', input);
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
