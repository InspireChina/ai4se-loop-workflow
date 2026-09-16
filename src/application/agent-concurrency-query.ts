import type Database from 'better-sqlite3';
import { z } from 'zod';

export const DEFAULT_AGENT_CONCURRENCY = 4;
export const MAX_AGENT_CONCURRENCY = 32;
export const agentConcurrencySchema = z.coerce.number().int('Agent 并发数必须是整数')
  .min(1, 'Agent 并发数不能小于 1')
  .max(MAX_AGENT_CONCURRENCY, `Agent 并发数不能大于 ${MAX_AGENT_CONCURRENCY}`);

export function agentConcurrencyInDb(db: Database.Database) {
  const row = db.prepare(`
    SELECT setting_value FROM project_settings WHERE setting_key = 'agent_concurrency'
  `).get() as { setting_value: string } | undefined;
  const parsed = agentConcurrencySchema.safeParse(row?.setting_value);
  return parsed.success ? parsed.data : DEFAULT_AGENT_CONCURRENCY;
}
