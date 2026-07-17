import { z } from 'zod';

export const softwareMaintenanceResultSchema = z.object({
  outcome: z.enum(['no_issue', 'fixed', 'not_repairable']),
  fingerprint: z.string().regex(/^[a-z0-9][a-z0-9-]{2,119}$/),
  classification: z.enum(['loop_bug', 'executor_issue', 'target_repo_issue', 'expected_failure', 'insufficient_evidence']),
  summary: z.string().min(10).max(1000),
  rootCause: z.string().min(1).max(3000),
  confidence: z.number().min(0).max(1),
  changedFiles: z.array(z.string().min(1).max(300)).max(12).default([]),
  tests: z.array(z.object({
    command: z.string().min(1).max(300),
    passed: z.boolean(),
    summary: z.string().max(1000),
  })).max(20).default([]),
  followUp: z.string().max(2000).default(''),
});

export type SoftwareMaintenanceResult = z.infer<typeof softwareMaintenanceResultSchema>;

export function parseSoftwareMaintenanceResult(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i)?.[1];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  const candidates = [trimmed, fenced, first >= 0 && last > first ? trimmed.slice(first, last + 1) : ''].filter(Boolean) as string[];
  let error: unknown;
  for (const candidate of candidates) {
    try { return softwareMaintenanceResultSchema.parse(JSON.parse(candidate)); }
    catch (cause) { error ??= cause; }
  }
  throw error || new Error('Maintenance Agent 未返回合法 JSON');
}
