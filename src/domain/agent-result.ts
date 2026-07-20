import { z } from 'zod';

const artifactSchema = z.object({
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(100000),
});

const questionSchema = z.object({
  decisionKey: z.string().min(1).max(240).optional(),
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  why: z.string().max(1000).optional().default(''),
  recommendation: z.string().max(2000).optional().default(''),
  recommendationReason: z.string().max(2000).optional().default(''),
  alternatives: z.array(z.object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(240),
    consequences: z.array(z.string().max(1000)).max(20).optional().default([]),
  })).max(20).optional().default([]),
  dependsOn: z.array(z.string().min(1).max(240)).max(50).optional().default([]),
});

const runtimeInputSchema = z.object({
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  why: z.string().max(1000).optional().default(''),
  recommendation: z.string().max(2000).optional().default(''),
});

const deliveryUnitSchema = z.object({ title: z.string().min(1).max(200) });

export const sliceSpecSchema = z.object({
  goal: z.string().min(1).max(4000),
  scope: z.object({
    included: z.array(z.string().min(1).max(2000)).min(1).max(100),
    excluded: z.array(z.string().min(1).max(2000)).max(100).default([]),
  }),
  behaviors: z.array(z.object({
    scenario: z.string().min(1).max(2000),
    expected: z.string().min(1).max(4000),
  })).min(1).max(100),
  decisions: z.array(z.object({
    key: z.string().min(1).max(240),
    decision: z.string().min(1).max(4000),
    rationale: z.string().min(1).max(4000),
    source: z.enum(['code', 'user', 'convention', 'safe_default']),
  })).max(200).default([]),
  ambiguities: z.array(z.object({
    key: z.string().min(1).max(240),
    description: z.string().min(1).max(4000),
  })).max(50).default([]),
  acceptanceCriteria: z.array(z.object({
    id: z.string().min(1).max(120),
    description: z.string().min(1).max(4000),
    oracle: z.string().min(1).max(4000),
  })).min(1).max(100),
  verificationPlan: z.array(z.object({
    criterionId: z.string().min(1).max(120),
    kind: z.enum(['command', 'browser', 'inspection']),
    instruction: z.string().min(1).max(4000),
    command: z.string().min(1).max(2000).optional(),
  })).min(1).max(100),
  dependencies: z.array(z.string().min(1).max(1000)).max(100).default([]),
  changeBudget: z.object({
    capabilities: z.array(z.string().min(1).max(500)).min(1).max(100),
    paths: z.array(z.string().min(1).max(1000)).max(200).default([]),
  }),
});

export const agentResultSchema = z.object({
  outcome: z.enum(['completed', 'needs_input', 'failed']),
  summary: z.string().min(1).max(4000),
  artifact: artifactSchema.optional(),
  questions: z.array(questionSchema).max(50).optional().default([]),
  runtimeInputs: z.array(runtimeInputSchema).max(50).optional().default([]),
  classification: z.enum(['feature', 'bug', 'tech', 'intake', 'other']).optional(),
  route: z.enum(['plan', 'repro']).optional(),
  deliveryUnits: z.array(deliveryUnitSchema).max(50).optional(),
  spec: sliceSpecSchema.optional(),
  // Read-only compatibility for results queued before the terminology change.
  stories: z.array(deliveryUnitSchema).max(50).optional(),
  verdict: z.enum(['passed', 'failed', 'report_ready', 'ready_for_approval', 'changes_requested']).optional(),
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
  const verdict = result.verdict === 'ready_for_approval' ? 'report_ready' as const : result.verdict;
  return {
    ...result,
    ...(verdict ? { verdict } : {}),
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
