import { revalidatePath } from 'next/cache';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AGENT_EXECUTORS, type AgentExecutorId } from '../domain/agent-executor';
import type { AgentExecutionOptions } from '../infrastructure/agent-executor';
import { databaseConnection, setConfiguredWorkspaceRoot } from '../infrastructure/database';

export const AGENT_EXECUTOR_OPTIONS: ReadonlyArray<{
  id: AgentExecutorId;
  label: string;
  description: string;
}> = [
  { id: 'cursor', label: 'Cursor', description: '使用 Cursor Agent CLI 执行每个推进步骤。' },
  { id: 'codex', label: 'Codex', description: '使用 Codex CLI 的非交互 JSON 模式执行。' },
  { id: 'claude', label: 'Claude', description: '使用 Claude Code CLI 的流式 JSON 模式执行。' },
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
const codexModelSchema = z.enum(CODEX_MODEL_OPTIONS.map((option) => option.id) as [CodexModel, ...CodexModel[]]);
const codexReasoningEffortSchema = z.enum(CODEX_REASONING_EFFORTS);
const claudeModelSchema = z.string().trim().max(200, 'Claude 模型名称不能超过 200 个字符').regex(/^[^\u0000-\u001f\u007f]*$/, 'Claude 模型名称包含无效控制字符');
const langfuseSampleRateSchema = z.coerce.number().min(0, '采样率不能小于 0').max(1, '采样率不能大于 1');

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
  claudeModel: string;
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
  const settings = await readProjectSettings(['agent_executor', 'codex_model', 'codex_reasoning_effort', 'claude_model']);
  const executor = executorSchema.safeParse(settings.agent_executor);
  const model = codexModelSchema.safeParse(settings.codex_model);
  const effort = codexReasoningEffortSchema.safeParse(settings.codex_reasoning_effort);
  const claudeModel = claudeModelSchema.safeParse(settings.claude_model ?? DEFAULT_CLAUDE_MODEL);
  return {
    executorId: executor.success ? executor.data : 'cursor',
    codexModel: model.success ? model.data : DEFAULT_CODEX_MODEL,
    codexReasoningEffort: effort.success ? effort.data : 'default',
    claudeModel: claudeModel.success ? claudeModel.data : DEFAULT_CLAUDE_MODEL,
  };
}

export async function setAgentExecutorSettings(input: { executorId: unknown; codexModel?: unknown; codexReasoningEffort?: unknown; claudeModel?: unknown }) {
  const executorId = executorSchema.parse(input.executorId);
  const codexModel = codexModelSchema.parse(input.codexModel ?? DEFAULT_CODEX_MODEL);
  const codexReasoningEffort = codexReasoningEffortSchema.parse(input.codexReasoningEffort ?? 'default');
  const claudeModel = claudeModelSchema.parse(input.claudeModel ?? DEFAULT_CLAUDE_MODEL);
  const db = await databaseConnection();
  const upsert = db.prepare(`INSERT INTO project_settings(setting_key, setting_value) VALUES(?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`);
  db.transaction(() => {
    upsert.run('agent_executor', executorId);
    upsert.run('codex_model', codexModel);
    upsert.run('codex_reasoning_effort', codexReasoningEffort);
    upsert.run('claude_model', claudeModel);
  })();
  try { revalidatePath('/settings'); } catch { /* CLI usage has no request context. */ }
  return { executorId, codexModel, codexReasoningEffort, claudeModel };
}

export async function setAgentExecutorId(input: unknown) {
  const current = await getAgentExecutorSettings();
  return setAgentExecutorSettings({ ...current, executorId: input });
}

export function agentExecutionOptions(settings: AgentExecutorSettings): AgentExecutionOptions {
  if (settings.executorId === 'codex') return {
    model: settings.codexModel || undefined,
    reasoningEffort: settings.codexReasoningEffort === 'default' ? undefined : settings.codexReasoningEffort,
  };
  if (settings.executorId === 'claude') return settings.claudeModel ? { model: settings.claudeModel } : {};
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
