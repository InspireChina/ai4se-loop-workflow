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
  const db = await databaseConnection();
  const row = db.prepare("SELECT setting_value FROM project_settings WHERE setting_key = 'agent_executor'").get() as { setting_value: string } | undefined;
  const parsed = executorSchema.safeParse(row?.setting_value);
  return parsed.success ? parsed.data : 'cursor';
}

export async function setAgentExecutorId(input: unknown) {
  const executorId = executorSchema.parse(input);
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO project_settings(setting_key, setting_value)
    VALUES('agent_executor', ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `).run(executorId);
  try { revalidatePath('/settings'); } catch { /* CLI usage has no request context. */ }
  return executorId;
}
