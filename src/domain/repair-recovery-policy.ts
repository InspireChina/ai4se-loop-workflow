import { z } from 'zod';
import type { AdminRuntimeConfiguration } from './admin-runtime-configuration';

export const repairRecoveryDecisionSchema = z.object({
  policyVersion: z.literal(1),
  failedAttemptIds: z.array(z.string().min(1)),
  method: z.enum(['investigate', 'minimal-reproduction', 'independent-diagnosis', 'replan', 'alternate-runtime']),
  switchRuntime: z.boolean(),
  // No fixed budget may turn an Agent failure into a human-input request.
  action: z.literal('continue-repair'),
}).strict();
export type RepairRecoveryDecision = z.infer<typeof repairRecoveryDecisionSchema>;

/** Durable failed/interrupted attempts, failed independent verifications and
 * normalized host-confirmed transition failures. A passed verification stays
 * passed even if its later handback fails; that cycle's failure is separate.
 * Never use CLI log volume or claimed findings to consume this budget. */
export function decideRepairRecovery(failedAttemptIds: readonly string[]): RepairRecoveryDecision {
  const ids = [...new Set(failedAttemptIds)];
  const methods = ['investigate', 'minimal-reproduction', 'independent-diagnosis', 'replan', 'alternate-runtime'] as const;
  const method = methods[Math.min(Math.floor(ids.length / 2), methods.length - 1)];
  return { policyVersion: 1, failedAttemptIds: ids, method, switchRuntime: method === 'alternate-runtime', action: 'continue-repair' };
}

function invocationIdentity(configuration: AdminRuntimeConfiguration) {
  return JSON.stringify([configuration.executorId, configuration.executionOptions.model ?? null,
    configuration.executionOptions.reasoningEffort ?? null, configuration.executionOptions.webSearch ?? null]);
}

/** Only already configured choices are eligible. A differently named copy of
 * the same executor/options is not a changed method. No invented fallback. */
export function selectRepairRuntime(primary: AdminRuntimeConfiguration, alternatives: readonly AdminRuntimeConfiguration[], decision: RepairRecoveryDecision) {
  if (!decision.switchRuntime) return { configuration: primary, changed: false };
  const primaryIdentity = invocationIdentity(primary);
  const seen = new Set([primaryIdentity]);
  const eligible = alternatives.filter(configuration => {
    const identity = invocationIdentity(configuration);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  if (!eligible.length) return { configuration: primary, changed: false };
  const index = Math.floor((decision.failedAttemptIds.length - 8) / 2) % eligible.length;
  return { configuration: eligible[index], changed: true };
}
