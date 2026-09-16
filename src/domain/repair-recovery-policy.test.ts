import assert from 'node:assert/strict';
import test from 'node:test';
import { decideRepairRecovery, selectRepairRuntime } from './repair-recovery-policy';
import type { AdminRuntimeConfiguration } from './admin-runtime-configuration';

const primary: AdminRuntimeConfiguration = { configurationId: 'primary', sourceVersion: 'v1', executorId: 'claude', executionOptions: { model: 'configured-a' } };
const alternate = { ...primary, configurationId: 'alternate', executorId: 'codex' as const, executionOptions: { model: 'configured-b' } };
const other = { ...alternate, configurationId: 'other', executionOptions: { model: 'configured-c' } };
const failures = (count: number) => Array.from({ length: count }, (_, index) => `failed-${index}`);

test('durable failures upgrade methods without a human exit or a reset from duplicate events', () => {
  const methods = ['investigate', 'minimal-reproduction', 'independent-diagnosis', 'replan', 'alternate-runtime'];
  for (const [index, method] of methods.entries()) {
    const decision = decideRepairRecovery(failures(index * 2));
    assert.equal(decision.method, method);
    assert.equal(decision.action, 'continue-repair');
    assert.deepEqual(decideRepairRecovery([...decision.failedAttemptIds, ...decision.failedAttemptIds]), decision);
  }
  assert.equal(decideRepairRecovery(failures(1000)).action, 'continue-repair');
});

test('Runtime escalation changes actual configured options, ignores renamed copies and rotates configured alternatives', () => {
  assert.deepEqual(selectRepairRuntime(primary, [alternate], decideRepairRecovery([])), { configuration: primary, changed: false });
  const duplicate = { ...primary, configurationId: 'renamed-primary' };
  assert.equal(selectRepairRuntime(primary, [duplicate], decideRepairRecovery(failures(8))).changed, false);
  assert.equal(selectRepairRuntime(primary, [duplicate, alternate, other], decideRepairRecovery(failures(8))).configuration, alternate);
  assert.equal(selectRepairRuntime(primary, [duplicate, alternate, other], decideRepairRecovery(failures(10))).configuration, other);
  assert.equal(selectRepairRuntime(primary, [duplicate, alternate, other], decideRepairRecovery(failures(12))).configuration, alternate);
});
