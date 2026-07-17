import { z } from 'zod';

const artifactSchema = z.object({
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(100000),
});

const questionSchema = z.object({
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  why: z.string().max(1000).optional().default(''),
  recommendation: z.string().max(2000).optional().default(''),
});

const deliveryUnitSchema = z.object({ title: z.string().min(1).max(200) });

export const agentResultSchema = z.object({
  outcome: z.enum(['completed', 'needs_input', 'failed']),
  summary: z.string().min(1).max(4000),
  artifact: artifactSchema.optional(),
  questions: z.array(questionSchema).max(50).optional().default([]),
  classification: z.enum(['feature', 'bug', 'tech', 'intake', 'other']).optional(),
  route: z.enum(['plan', 'repro']).optional(),
  deliveryUnits: z.array(deliveryUnitSchema).max(50).optional(),
  // Read-only compatibility for results queued before the terminology change.
  stories: z.array(deliveryUnitSchema).max(50).optional(),
  verdict: z.enum(['passed', 'failed', 'ready_for_approval', 'changes_requested']).optional(),
  rewindTo: z.enum(['plan', 'analysis', 'dev', 'test']).optional(),
  rewindDeliveryUnit: z.number().int().positive().optional(),
  rewindStory: z.number().int().positive().optional(),
  changedFiles: z.array(z.string().min(1).max(1000)).max(500).optional(),
  tests: z.array(z.object({
    command: z.string().min(1).max(2000),
    passed: z.boolean(),
    summary: z.string().max(4000).optional().default(''),
  })).max(100).optional(),
}).transform((result) => {
  const deliveryUnits = result.deliveryUnits || result.stories;
  const rewindDeliveryUnit = result.rewindDeliveryUnit || result.rewindStory;
  return {
    ...result,
    ...(deliveryUnits ? { deliveryUnits } : {}),
    ...(rewindDeliveryUnit ? { rewindDeliveryUnit } : {}),
  };
});

export type AgentResult = z.infer<typeof agentResultSchema>;

function extractJsonObjects(text: string) {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function parseAgentResult(text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Agent 最终回复为空');

  const candidates = [
    trimmed,
    ...Array.from(trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gi), (match) => match[1].trim()).reverse(),
    ...extractJsonObjects(trimmed).reverse(),
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      return agentResultSchema.parse(JSON.parse(candidate));
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}
