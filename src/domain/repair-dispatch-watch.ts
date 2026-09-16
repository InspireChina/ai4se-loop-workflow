import type { RepairBusinessReadiness } from './repair-followup';

export const REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS = 120000;
export const REPAIR_DISPATCH_STALL_MS = 20 * 60 * 1000;

export type RepairDispatchWatch = {
  intentRevision: number;
  readiness: RepairBusinessReadiness;
  eligibleElapsedMs: number;
  lastSampleAt: number;
};

function currentSample(watch: RepairDispatchWatch, now: number, intentRevision: number) {
  const delta = now - watch.lastSampleAt;
  return Number.isSafeInteger(watch.lastSampleAt) && watch.lastSampleAt >= 0
    && Number.isSafeInteger(watch.eligibleElapsedMs) && watch.eligibleElapsedMs >= 0
    && watch.intentRevision === intentRevision
    && delta >= 0 && delta <= REPAIR_DISPATCH_SAMPLE_MAX_GAP_MS;
}

/** Only adjacent, trusted runnable samples prove a continuous eligible
 * interval. A long gap or clock rollback starts a new interval; it cannot
 * combine unrelated intervals into authority to take business work back. */
export function sampleRepairDispatchWatch(prior: RepairDispatchWatch | undefined,
  readiness: RepairBusinessReadiness, now: number, intentRevision: number): RepairDispatchWatch {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(intentRevision) || intentRevision < 0) {
    throw new Error('派发观察需要有效时钟和运行意图代次');
  }
  const continuous = prior && readiness === 'runnable' && prior.readiness === 'runnable'
    && currentSample(prior, now, intentRevision);
  return { intentRevision, readiness, lastSampleAt: now,
    eligibleElapsedMs: continuous ? prior.eligibleElapsedMs + now - prior.lastSampleAt : 0 };
}

/** Persisted history is not a fresh observation. Recheck freshness when
 * authorizing the eventual hold/observation, not just when sampling. */
export function repairDispatchStallDue(watch: RepairDispatchWatch | undefined, now: number, intentRevision: number) {
  return Boolean(watch && Number.isSafeInteger(now) && now >= 0
    && watch.readiness === 'runnable' && currentSample(watch, now, intentRevision)
    && watch.eligibleElapsedMs >= REPAIR_DISPATCH_STALL_MS);
}
