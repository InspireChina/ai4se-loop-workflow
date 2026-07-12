import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AGENT_EXECUTORS, type AgentExecutorId } from '../domain/agent-executor';
import { databaseConnection } from '../infrastructure/database';

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
