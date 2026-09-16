import assert from 'node:assert/strict';
import test from 'node:test';
import { runRecoverySoak } from './recovery-soak';

function audit(at: number, violations: Array<{ code: string; detail: string }> = []) {
  return {
    schema: 'loop-recovery-acceptance-audit/v1', generatedAt: at, expectStopped: false, requiredCaseIds: [],
    admin: { casesByStatus: {}, attemptsByStatus: {}, cases: [], activeAttempts: [], activeProcesses: [] },
    business: { tasksByStatus: {}, executionsByStatus: {}, interventionsByStatus: {}, activeProcesses: [] },
    violations, passed: violations.length === 0,
  };
}

test('soak checkpoints every sample and requires the final audit to pass', async () => {
  let clock = 0; const checkpoints: Array<Record<string, unknown>> = [];
  const result = await runRecoverySoak({ durationMs: 20, pollMs: 10, requiredCaseIds: ['case'], now: () => clock,
    wait: async ms => { clock += ms; }, readAudit: final => audit(clock, final ? [] : []),
    writeCheckpoint: report => { checkpoints.push(structuredClone(report)); },
  });
  assert.equal(result.completed, true);
  assert.equal(result.passed, true);
  assert.deepEqual(result.samples.map(sample => sample.at), [0, 10, 20]);
  assert.equal(checkpoints.length, 4, 'initial, two in-progress and one completed checkpoint');
});

test('a transient invariant violation remains a failed soak even if the end is clean', async () => {
  let clock = 0;
  const result = await runRecoverySoak({ durationMs: 10, pollMs: 5, requiredCaseIds: [], now: () => clock,
    wait: async ms => { clock += ms; }, readAudit: () => audit(clock, clock === 5 ? [{ code: 'duplicate-active-admin', detail: 'duplicate' }] : []),
    writeCheckpoint: () => undefined,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.violationOccurrences, [{ at: 5, code: 'duplicate-active-admin', detail: 'duplicate' }]);
});
