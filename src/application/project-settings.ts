import { revalidatePath } from 'next/cache';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AGENT_EXECUTORS, type AgentExecutorId } from '../domain/agent-executor';
import { databaseConnection, setConfiguredWorkspaceRoot } from '../infrastructure/database';

export const AGENT_EXECUTOR_OPTIONS: ReadonlyArray<{
  id: AgentExecutorId;
  label: string;
  description: string;
}> = [
  { id: 'cursor', label: 'Cursor', description: '使用 Cursor Agent CLI 执行每个 pipeline agent。' },
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
const codexModelSchema = z.enum(CODEX_MODEL_OPTIONS.map((option) => option.id) as [CodexModel, ...CodexModel[]]);
const codexReasoningEffortSchema = z.enum(CODEX_REASONING_EFFORTS);

export type AgentExecutorSettings = {
  executorId: AgentExecutorId;
  codexModel: CodexModel;
  codexReasoningEffort: CodexReasoningEffort;
};

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
  const db = await databaseConnection();
  const rows = db.prepare("SELECT setting_key, setting_value FROM project_settings WHERE setting_key IN ('agent_executor', 'codex_model', 'codex_reasoning_effort')").all() as { setting_key: string; setting_value: string }[];
  const settings = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  const executor = executorSchema.safeParse(settings.agent_executor);
  const model = codexModelSchema.safeParse(settings.codex_model);
  const effort = codexReasoningEffortSchema.safeParse(settings.codex_reasoning_effort);
  return {
    executorId: executor.success ? executor.data : 'cursor',
    codexModel: model.success ? model.data : DEFAULT_CODEX_MODEL,
    codexReasoningEffort: effort.success ? effort.data : 'default',
  };
}

export async function setAgentExecutorSettings(input: { executorId: unknown; codexModel?: unknown; codexReasoningEffort?: unknown }) {
  const executorId = executorSchema.parse(input.executorId);
  const codexModel = codexModelSchema.parse(input.codexModel ?? DEFAULT_CODEX_MODEL);
  const codexReasoningEffort = codexReasoningEffortSchema.parse(input.codexReasoningEffort ?? 'default');
  const db = await databaseConnection();
  const upsert = db.prepare(`INSERT INTO project_settings(setting_key, setting_value) VALUES(?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`);
  db.transaction(() => {
    upsert.run('agent_executor', executorId);
    upsert.run('codex_model', codexModel);
    upsert.run('codex_reasoning_effort', codexReasoningEffort);
  })();
  try { revalidatePath('/settings'); } catch { /* CLI usage has no request context. */ }
  return { executorId, codexModel, codexReasoningEffort };
}

export async function setAgentExecutorId(input: unknown) {
  const current = await getAgentExecutorSettings();
  return setAgentExecutorSettings({ ...current, executorId: input });
}
