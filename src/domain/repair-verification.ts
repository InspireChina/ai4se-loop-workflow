import { z } from 'zod';

const text = z.string().trim().min(1);
const checkSchema = z.object({ targetRef: text, command: text }).strict();
/** The host derives this plan from original contracts. Agent proposals are
 * investigation evidence, not authority to redefine acceptance. */
export const repairVerificationPlanSchema = z.object({
  sourceRepairAttemptId: text,
  expectedVersion: text,
  originalObservationIds: z.array(text).min(1).max(10000),
  versionCommand: text,
  reproduction: checkSchema,
  acceptanceChecks: z.array(checkSchema).min(1).max(10000),
}).strict().superRefine((plan, ctx) => {
  const refs = plan.acceptanceChecks.map(check => check.targetRef);
  if (new Set(refs).size !== refs.length) ctx.addIssue({ code: 'custom', message: '验收目标不能重复' });
  if (new Set(plan.originalObservationIds).size !== plan.originalObservationIds.length) {
    ctx.addIssue({ code: 'custom', message: '原始失败引用不能重复' });
  }
});
export type RepairVerificationPlan = z.infer<typeof repairVerificationPlanSchema>;

export function repairVerificationSteps(plan: RepairVerificationPlan) {
  return [
    { kind: 'version-before' as const, targetRef: 'runtime-version', command: plan.versionCommand },
    { kind: 'reproduction' as const, ...plan.reproduction },
    ...plan.acceptanceChecks.map(check => ({ kind: 'acceptance' as const, ...check })),
    { kind: 'version-after' as const, targetRef: 'runtime-version', command: plan.versionCommand },
  ];
}

const commandResultSchema = z.object({
  exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), exitConfirmed: z.boolean(),
}).strict();
export type VerificationCommandResult = z.infer<typeof commandResultSchema>;
export const repairVerificationCheckSchema = z.object({
  kind: z.enum(['version-before', 'reproduction', 'acceptance', 'version-after']),
  targetRef: text, command: text, result: commandResultSchema,
}).strict();
export const repairVerificationReceiptSchema = z.object({
  plan: repairVerificationPlanSchema,
  checks: z.array(repairVerificationCheckSchema).max(10003),
  passed: z.boolean(), exitConfirmed: z.boolean(), reason: text,
}).strict().superRefine((receipt, ctx) => {
  const steps = repairVerificationSteps(receipt.plan);
  for (const [index, check] of receipt.checks.entries()) {
    const step = steps[index];
    if (!step || step.kind !== check.kind || step.targetRef !== check.targetRef || step.command !== check.command) {
      ctx.addIssue({ code: 'custom', message: '验证收据未按原始计划执行' });
    }
  }
  if (receipt.passed && (!receipt.exitConfirmed || receipt.checks.length !== steps.length || receipt.checks.some(check =>
    !check.result.exitConfirmed || check.result.exitCode !== 0 ||
    ((check.kind === 'version-before' || check.kind === 'version-after') && check.result.stdout.trim() !== receipt.plan.expectedVersion)))) {
    ctx.addIssue({ code: 'custom', message: '验证成功必须有完整复现、验收、版本与物理退出证据' });
  }
});
export type RepairVerificationReceipt = z.infer<typeof repairVerificationReceiptSchema>;
