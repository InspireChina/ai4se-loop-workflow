import { z } from 'zod';

const text = z.string().trim().min(1);
/** Current owned workspace, distinct from immutable historical failures. */
export const repairWorkspaceAnchorSchema = z.object({
  taskId: text, itemId: text, itemRevision: z.number().int().positive(),
  itemEpoch: z.number().int().nonnegative(), workspaceRoot: text,
  predecessors: z.array(z.object({ itemId: text, revision: z.number().int().positive() }).strict()).max(1000).optional(),
}).strict();
export const repairHandoffTargetSchema = z.object({
  caseId: text, verificationAttemptId: text, repairGeneration: z.number().int().positive(),
  repairOwnerId: text, repairSupervisionToken: z.number().int().nonnegative(),
  taskId: text, itemId: text, itemRevision: z.number().int().positive(), itemEpoch: z.number().int().positive(),
  expectedVersion: text, reason: text,
}).strict();
export const repairHandoffReceiptSchema = z.object({
  target: repairHandoffTargetSchema, workspaceRoot: text, dispatchEpoch: z.number().int().positive(),
  previousExecutionIds: z.array(text), resolvedInterventionIds: z.array(text).min(1), executionIds: z.array(text).length(0),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.dispatchEpoch !== receipt.target.itemEpoch + 1) ctx.addIssue({ code: 'custom', message: '交还必须从原始工作项 cycle 创建已验证版本的新 cycle' });
});
export type RepairHandoffTarget = z.infer<typeof repairHandoffTargetSchema>;
export type RepairHandoffReceipt = z.infer<typeof repairHandoffReceiptSchema>;
export const repairBusinessProgressSchema = z.object({
  executionId: text, resultId: text, completionEventId: text, itemId: text, taskId: text,
  itemRevision: z.number().int().positive(), dispatchEpoch: z.number().int().positive(),
}).strict();
export type RepairBusinessProgress = z.infer<typeof repairBusinessProgressSchema>;
export const repairBusinessReadinessSchema = z.enum(['runnable', 'executing', 'waiting', 'paused', 'ended', 'source-changed']);
export type RepairBusinessReadiness = z.infer<typeof repairBusinessReadinessSchema>;
export class RepairHandoffVersionChanged extends Error {
  constructor(readonly expectedVersion: string, readonly actualVersion: string, readonly workspaceRoot: string) {
    super('交还时实际版本与独立验证版本不一致；需要重新验证');
    this.name = 'RepairHandoffVersionChanged';
  }
}
