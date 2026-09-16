import { repairVerificationPlanSchema, repairVerificationSteps, type RepairVerificationReceipt, type VerificationCommandResult } from '../domain/repair-verification';
export { repairVerificationPlanSchema, type RepairVerificationPlan, type RepairVerificationReceipt, type VerificationCommandResult } from '../domain/repair-verification';

/** Sequential independent execution. An exit-zero summary is not a pass:
 * both version reads must match and all original checks must really finish.
 * Commands run through a physical execution adapter, outside normal slots. */
export async function executeIndependentRepairVerification(input: unknown, ports: {
  signal: AbortSignal;
  run: (command: string, signal: AbortSignal) => Promise<VerificationCommandResult>;
  persist: (key: string, evidence: Record<string, unknown>) => Promise<void>;
  continueOnCheckFailure?: boolean;
}): Promise<RepairVerificationReceipt> {
  const plan = repairVerificationPlanSchema.parse(input);
  const checks: RepairVerificationReceipt['checks'] = [];
  const steps = repairVerificationSteps(plan);
  await ports.persist('verification-plan', { plan });
  for (const [index, step] of steps.entries()) {
    if (ports.signal.aborted) return { plan, checks, passed: false, exitConfirmed: true, reason: '独立验证被停止' };
    const result = await ports.run(step.command, ports.signal);
    const evidence = { ...step, result };
    checks.push(evidence);
    // A failed receipt write throws: loss of evidence can never become pass.
    await ports.persist(`verification-check-${index}`, evidence);
    if (!result.exitConfirmed) return { plan, checks, passed: false, exitConfirmed: false, reason: '验证进程或后代退出未确认' };
    if (ports.signal.aborted) return { plan, checks, passed: false, exitConfirmed: true, reason: '独立验证被停止' };
    if (result.exitCode !== 0 && (!ports.continueOnCheckFailure || result.exitCode === null
      || step.kind === 'version-before' || step.kind === 'version-after')) return { plan, checks, passed: false, exitConfirmed: true, reason: `${step.kind}/${step.targetRef} 验证失败` };
    if ((step.kind === 'version-before' || step.kind === 'version-after') && result.stdout.trim() !== plan.expectedVersion) {
      return { plan, checks, passed: false, exitConfirmed: true, reason: '验证使用的版本与修复版本不一致' };
    }
  }
  if (checks.some(check => check.result.exitCode !== 0)) return { plan, checks, passed: false, exitConfirmed: true, reason: '原始失败和验收诊断已执行，包含非零检查结果' };
  return { plan, checks, passed: true, exitConfirmed: true, reason: '原始失败、相关验收与前后版本独立验证通过；等待业务交还与推进观察' };
}
