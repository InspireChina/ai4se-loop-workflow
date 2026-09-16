import { z } from 'zod';

const text = z.string().trim().min(1).max(16000);
const observationIds = z.array(text).min(1).max(10000)
  .refine(ids => new Set(ids).size === ids.length, '原始故障引用不能重复');
const proposedChecks = z.object({
  reproductionCommand: text, versionCheckCommand: text,
  acceptanceChecks: z.array(z.object({ targetRef: text, command: text, expected: text }).strict()).min(1).max(100),
}).strict();
export const adminSubmissionSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('verification-requested'), summary: text, repairVersion: text,
    originalObservationIds: observationIds,
    repairEvidenceKeys: z.array(text).min(1).max(100),
    verification: z.object({
      reproductionCommand: text,
      versionCheckCommand: text,
      acceptanceChecks: z.array(z.object({ targetRef: text, command: text, expected: text }).strict()).min(1).max(100),
    }).strict(),
  }).strict(),
  z.object({ outcome: z.literal('diagnosis-requested'), summary: text, baselineVersion: text,
    originalObservationIds: observationIds, verification: proposedChecks,
  }).strict(),
  z.object({
    outcome: z.literal('external-wait-requested'), summary: text,
    dependency: text, diagnosisAttemptId: text, baselineVersion: text,
    originalObservationIds: observationIds, evidenceKey: text,
    retryAfterMs: z.number().int().min(30_000).max(24 * 60 * 60 * 1000),
  }).strict(),
  z.object({ outcome: z.literal('deferred'), summary: text, nextMethod: text }).strict(),
]);
export type AdminSubmission = z.infer<typeof adminSubmissionSchema>;
export type AdminCommandCredential = { caseId: string; attemptId: string; sessionId: string; token: string };

export const adminActionSchema = z.discriminatedUnion('kind', [z.object({
  kind: z.literal('workspace-takeover'), itemId: text, itemRevision: z.number().int().positive(), reason: text,
}).strict(), z.object({kind:z.literal('harness-workspace'),observationId:text,reason:text}).strict(),
z.object({kind:z.literal('harness-build'),workspaceKey:text,reason:text}).strict()]);
export type AdminAction = z.infer<typeof adminActionSchema>;
export type AdminActionRecord = {
  key: string; action: AdminAction; status: 'pending' | 'completed' | 'failed'; result: Record<string, unknown> | null;
};
