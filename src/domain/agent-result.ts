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

export const agentResultSchema = z.object({
  outcome: z.enum(['completed', 'needs_input', 'failed']),
  summary: z.string().min(1).max(4000),
  artifact: artifactSchema.optional(),
  questions: z.array(questionSchema).max(50).optional().default([]),
  classification: z.enum(['feature', 'bug', 'tech', 'intake', 'other']).optional(),
  route: z.enum(['plan', 'repro']).optional(),
  stories: z.array(z.object({ title: z.string().min(1).max(200) })).max(50).optional(),
  verdict: z.enum(['passed', 'failed', 'ready_for_approval', 'changes_requested']).optional(),
  rewindTo: z.enum(['plan', 'analysis', 'dev', 'test']).optional(),
  rewindStory: z.number().int().positive().optional(),
  changedFiles: z.array(z.string().min(1).max(1000)).max(500).optional(),
  tests: z.array(z.object({
    command: z.string().min(1).max(2000),
    passed: z.boolean(),
    summary: z.string().max(4000).optional().default(''),
  })).max(100).optional(),
});

export type AgentResult = z.infer<typeof agentResultSchema>;

export function parseAgentResult(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced || trimmed;
  return agentResultSchema.parse(JSON.parse(candidate));
}
