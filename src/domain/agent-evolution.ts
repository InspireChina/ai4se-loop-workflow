import { z } from 'zod';

export const evolutionObservationSchema = z.object({
  fingerprint: z.string().regex(/^[a-z0-9][a-z0-9-]{2,119}$/),
  category: z.enum(['tool-usage', 'reasoning', 'verification', 'output-contract', 'workflow-efficiency']),
  summary: z.string().min(10).max(500),
  guidance: z.string().min(10).max(1000),
  target: z.enum(['daily', 'memory', 'prompt']),
  confidence: z.number().min(0).max(1),
  reusable: z.boolean(),
});

export const evolutionResultSchema = z.object({
  summary: z.string().min(1).max(1000),
  observations: z.array(evolutionObservationSchema).max(5).default([]),
});

export type EvolutionResult = z.infer<typeof evolutionResultSchema>;

export function parseEvolutionResult(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i)?.[1];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  const candidates = [trimmed, fenced, first >= 0 && last > first ? trimmed.slice(first, last + 1) : ''].filter(Boolean) as string[];
  let error: unknown;
  for (const candidate of candidates) {
    try { return evolutionResultSchema.parse(JSON.parse(candidate)); }
    catch (cause) { error ??= cause; }
  }
  throw error || new Error('Evolution Evaluator 未返回 JSON');
}
