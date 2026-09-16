import type { auditRecoveryAcceptance } from './recovery-acceptance-audit';

type Audit = ReturnType<typeof auditRecoveryAcceptance>;
type CompactSample = {
  at: number; passed: boolean; violationCodes: string[];
  casesByStatus: Record<string, number>; attemptsByStatus: Record<string, number>;
  tasksByStatus: Record<string, number>; executionsByStatus: Record<string, number>;
  activeAdminProcesses: number; activeBusinessProcesses: number;
};

function compact(audit: Audit): CompactSample {
  const business = audit.business as { tasksByStatus?: Record<string, number>; executionsByStatus?: Record<string, number>; activeProcesses?: unknown[] } | null;
  return {
    at: audit.generatedAt, passed: audit.passed, violationCodes: audit.violations.map(row => row.code),
    casesByStatus: audit.admin.casesByStatus, attemptsByStatus: audit.admin.attemptsByStatus,
    tasksByStatus: business?.tasksByStatus || {}, executionsByStatus: business?.executionsByStatus || {},
    activeAdminProcesses: audit.admin.activeProcesses.length, activeBusinessProcesses: business?.activeProcesses?.length || 0,
  };
}

/** Long-running observer with injected time/wait ports for deterministic tests.
 * Checkpoints are written after every sample, including the incomplete start. */
export async function runRecoverySoak(ports: {
  durationMs: number; pollMs: number; requiredCaseIds: string[]; signal?: AbortSignal;
  readAudit: (final: boolean) => Audit | Promise<Audit>;
  writeCheckpoint: (report: Record<string, unknown>) => void | Promise<void>;
  now?: () => number; wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  if (!Number.isSafeInteger(ports.durationMs) || ports.durationMs <= 0 || !Number.isSafeInteger(ports.pollMs) || ports.pollMs <= 0) {
    throw new Error('Soak duration and poll interval must be positive integers');
  }
  const now = ports.now ?? Date.now;
  const wait = ports.wait ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error('soak aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
  }));
  const startedAt = now(), deadline = startedAt + ports.durationMs;
  const samples: CompactSample[] = [];
  const violationOccurrences: Array<{ at: number; code: string; detail: string; ids?: string[] }> = [];
  let firstAudit: Audit | undefined, lastAudit: Audit | undefined;
  const report = (completed: boolean, interrupted = false) => ({
    schema: 'loop-recovery-soak/v1', startedAt, updatedAt: now(), durationMs: ports.durationMs, pollMs: ports.pollMs,
    requiredCaseIds: [...new Set(ports.requiredCaseIds)], completed, interrupted, samples,
    firstAudit, lastAudit, violationOccurrences,
    passed: completed && !interrupted && violationOccurrences.length === 0 && Boolean(lastAudit?.passed),
  });
  await ports.writeCheckpoint(report(false));
  try {
    while (true) {
      ports.signal?.throwIfAborted();
      const final = now() >= deadline;
      const audit = await ports.readAudit(final);
      firstAudit ||= audit; lastAudit = audit; samples.push(compact(audit));
      for (const violation of audit.violations) violationOccurrences.push({ at: audit.generatedAt, ...violation });
      if (final) { const completed = report(true); await ports.writeCheckpoint(completed); return completed; }
      await ports.writeCheckpoint(report(false));
      await wait(Math.min(ports.pollMs, Math.max(1, deadline - now())), ports.signal);
    }
  } catch (error) {
    await ports.writeCheckpoint(report(false, true));
    throw error;
  }
}
