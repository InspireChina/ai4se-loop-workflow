import assert from 'node:assert/strict';
import test from 'node:test';
import { repairDispatchStallDue, sampleRepairDispatchWatch,
  REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS, REPAIR_DISPATCH_STALL_MS } from './repair-dispatch-watch';
import type { RepairBusinessReadiness } from './repair-followup';

test('dispatch stall requires continuous eligible samples and a fresh final authorization', () => {
  let watch = sampleRepairDispatchWatch(undefined, 'runnable', 1000, 1);
  for (let minute = 1; minute <= 20; minute++) {
    watch = sampleRepairDispatchWatch(watch, 'runnable', 1000 + minute * 60000, 1);
    assert.equal(repairDispatchStallDue(watch, watch.lastSampleAt, 1), minute === 20);
  }
  assert.equal(watch.eligibleElapsedMs, REPAIR_DISPATCH_STALL_MS);
  assert.equal(repairDispatchStallDue(watch, watch.lastSampleAt + REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS, 1), true);
  assert.equal(repairDispatchStallDue(watch, watch.lastSampleAt + REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS + 1, 1), false);
  assert.equal(repairDispatchStallDue(watch, watch.lastSampleAt - 1, 1), false);
  assert.equal(repairDispatchStallDue(watch, watch.lastSampleAt, 2), false);
  assert.equal(sampleRepairDispatchWatch(watch, 'runnable', watch.lastSampleAt, 1).eligibleElapsedMs, watch.eligibleElapsedMs,
    'duplicate polling must not manufacture time');
  assert.equal(sampleRepairDispatchWatch(watch, 'runnable', watch.lastSampleAt + REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS + 1, 1).eligibleElapsedMs, 0);
  assert.equal(sampleRepairDispatchWatch(watch, 'runnable', watch.lastSampleAt - 1, 1).eligibleElapsedMs, 0);
});

test('normal waits, executing long commands, intent changes and invalid timestamps never earn dispatch stall time', () => {
  const prior = { intentRevision: 1, readiness: 'runnable' as const, eligibleElapsedMs: REPAIR_DISPATCH_STALL_MS, lastSampleAt: 1000 };
  const waits: RepairBusinessReadiness[] = ['executing', 'waiting', 'paused', 'ended', 'source-changed'];
  for (const readiness of waits) {
    const waiting = sampleRepairDispatchWatch(prior, readiness, 2000, 1);
    assert.equal(waiting.eligibleElapsedMs, 0);
    assert.equal(repairDispatchStallDue(waiting, 2000, 1), false);
    assert.equal(sampleRepairDispatchWatch(waiting, 'runnable', 3000, 1).eligibleElapsedMs, 0);
  }
  assert.equal(sampleRepairDispatchWatch(prior, 'runnable', 2000, 2).eligibleElapsedMs, 0);
  for (const invalid of [NaN, Infinity, -1, 1.5]) {
    assert.throws(() => sampleRepairDispatchWatch(prior, 'runnable', invalid, 1), /有效时钟/);
    assert.equal(repairDispatchStallDue(prior, invalid, 1), false);
    assert.equal(repairDispatchStallDue({ ...prior, lastSampleAt: invalid }, 2000, 1), false);
    assert.equal(repairDispatchStallDue({ ...prior, eligibleElapsedMs: invalid }, 2000, 1), false);
  }
});
