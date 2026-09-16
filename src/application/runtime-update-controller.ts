import type { AdminManagementStore } from '../infrastructure/admin-management-store';
import { runtimeRollbackTarget, RuntimeCompatibilityResample, runtimeUpdateIdSchema, runtimeUpdateTerminal, type RuntimeArtifact, type RuntimeUpdateAuthority, type RuntimeUpdateRecord } from '../domain/runtime-update';
import { sanitizeDiagnosticText } from '../infrastructure/diagnostic-text';

type Check = () => void;
/** External orchestration core. No Runner, business DB or file replacement.
 * Ports must target immutable installed artifacts and prove physical exits;
 * startHeld must recover a durable launch intent, not spawn again on replay. */
export function createRuntimeUpdateController(ports: {
  store: Pick<AdminManagementStore, 'runtimeUpdate' | 'acquireRuntimeUpdate' | 'renewRuntimeUpdate' | 'assertRuntimeUpdate' | 'advanceRuntimeUpdate' | 'reissueLegacyRuntimeUpdate' | 'recordRuntimeUpdateResample' | 'control'>;
  ownerId: string;
  stopOwned: (update: RuntimeUpdateRecord, authority: RuntimeUpdateAuthority, assertCurrent: Check) => Promise<boolean>;
  freezeBusinessBaseline?: (update: RuntimeUpdateRecord, signal: AbortSignal, assertCurrent: Check) => Promise<void>;
  prepareRollbackArtifact?: (update: RuntimeUpdateRecord, signal: AbortSignal, assertCurrent: Check) => Promise<RuntimeUpdateRecord>;
  validateArtifactAndCompatibility: (artifact: RuntimeArtifact, update: RuntimeUpdateRecord, signal: AbortSignal, assertCurrent: Check) => Promise<void>;
  startHeld: (artifact: RuntimeArtifact, update: RuntimeUpdateRecord, signal: AbortSignal, assertCurrent: Check) => Promise<void>;
  activate: (artifact: RuntimeArtifact, update: RuntimeUpdateRecord, signal: AbortSignal, assertCurrent: Check) => Promise<void>;
  observeStartup: (artifact: RuntimeArtifact, update: RuntimeUpdateRecord, signal: AbortSignal, assertCurrent: Check) => Promise<'healthy' | 'waiting' | 'failed'>;
  cancelOwned: (authority: RuntimeUpdateAuthority) => Promise<void>;
  onError?: (error: unknown) => void;
  scheduleInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
  cancelInterval?: (timer: NodeJS.Timeout) => void;
}) {
  let inFlight: Promise<RuntimeUpdateRecord | null> | undefined;
  let active: { authority: RuntimeUpdateAuthority; abort: AbortController } | undefined;
  let lastOwned: RuntimeUpdateAuthority | undefined;
  let closed = false;
  const report = (error: unknown) => { try { ports.onError?.(error); } catch { /* never block process cleanup */ } };
  async function work(updateId: string) {
    let current = ports.store.runtimeUpdate(updateId);
    if (!current || runtimeUpdateTerminal(current.phase) || closed) return current;
    const authority = ports.store.acquireRuntimeUpdate(updateId, ports.ownerId);
    if (!authority) return current;
    lastOwned = authority;
    const abort = new AbortController(); active = { authority, abort };
    const assertOwned = () => { if (closed || abort.signal.aborted) throw new Error('外部更新已取消'); ports.store.assertRuntimeUpdate(authority, false); };
    const assertCurrent = () => { assertOwned(); ports.store.assertRuntimeUpdate(authority); };
    let cancelling: Promise<void> | undefined;
    const cancel = () => {
      abort.abort();
      if (!cancelling) cancelling = Promise.resolve().then(() => ports.cancelOwned(authority)).catch(report);
    };
    // Renewal and stop/fence observation are independent of slow probe/start.
    const timer = (ports.scheduleInterval || setInterval)(() => {
      try { assertOwned(); if (!ports.store.renewRuntimeUpdate(authority)) throw new Error('外部更新续租失败'); assertCurrent(); }
      catch (error) { report(error); cancel(); }
    }, 1000);
    timer.unref();
    try {
      current = ports.store.assertRuntimeUpdate(authority, false);
      if (ports.store.control().intent_revision !== current.intentRevision) {
        // Never restart either version to satisfy an obsolete user intent.
        if (!await ports.stopOwned(current, authority, assertOwned)) return current;
        assertOwned();
        return ports.store.advanceRuntimeUpdate(authority,current.phase,'aborted', { selected: current.request.before, permitChangedIntent: true });
      }
      if (!runtimeUpdateIdSchema.safeParse(current.request.updateId).success) {
        // Neither candidate nor rollback can start with an ID rejected by
        // their CLI. Recover the protocol without altering the old request or
        // bypassing containment/live-data rollback compatibility.
        if (!await ports.stopOwned(current, authority, assertCurrent)) return current;
        assertCurrent();
        if (ports.prepareRollbackArtifact) current = await ports.prepareRollbackArtifact(current, abort.signal, assertCurrent);
        await ports.validateArtifactAndCompatibility(runtimeRollbackTarget(current), current, abort.signal, assertCurrent);
        assertCurrent();
        if (!await ports.stopOwned(current, authority, assertCurrent)) return current;
        assertCurrent();
        return ports.store.reissueLegacyRuntimeUpdate(authority);
      }
      const transition = (phase: RuntimeUpdateRecord['phase'], options?: Parameters<typeof ports.store.advanceRuntimeUpdate>[3]) => {
        assertCurrent(); current = ports.store.advanceRuntimeUpdate(authority,current!.phase,phase,options); return current;
      };
      const probeFailure = (error: unknown) => {
        assertCurrent(); report(error);
        if (error instanceof RuntimeCompatibilityResample) return ports.store.recordRuntimeUpdateResample(authority, error.message);
        return transition('rolling-back', { failure: sanitizeDiagnosticText(error) });
      };
      switch (current.phase) {
        case 'stopping':
          try {
            if (ports.prepareRollbackArtifact) current = await ports.prepareRollbackArtifact(current,abort.signal,assertCurrent);
            await ports.validateArtifactAndCompatibility(current.request.candidate,current,abort.signal,assertCurrent);
            assertCurrent(); if (!await ports.stopOwned(current,authority,assertCurrent)) return current;
            if(ports.freezeBusinessBaseline)await ports.freezeBusinessBaseline(current,abort.signal,assertCurrent);
            assertCurrent();
            return transition('candidate-starting');
          } catch (error) { return probeFailure(error); }
        case 'candidate-starting':
          try {
            await ports.validateArtifactAndCompatibility(current.request.candidate,current,abort.signal,assertCurrent);
            await ports.startHeld(current.request.candidate,current,abort.signal,assertCurrent);
            return transition('candidate-activating');
          } catch (error) { return probeFailure(error); }
        case 'candidate-activating':
          try { await ports.validateArtifactAndCompatibility(current.request.candidate,current,abort.signal,assertCurrent); await ports.activate(current.request.candidate,current,abort.signal,assertCurrent); return transition('candidate-observing',{ selected: current.request.candidate }); }
          catch (error) { return probeFailure(error); }
        case 'candidate-observing': {
          try {
            await ports.validateArtifactAndCompatibility(current.request.candidate,current,abort.signal,assertCurrent);
            const result = await ports.observeStartup(current.request.candidate,current,abort.signal,assertCurrent);
            if (result === 'waiting') return current;
            return transition(result === 'healthy' ? 'succeeded' : 'rolling-back',result === 'failed' ? { failure: 'Candidate startup health failed' } : undefined);
          } catch (error) { return probeFailure(error); }
        }
        case 'rolling-back':
          if (!await ports.stopOwned(current,authority,assertCurrent)) return current;
          if (ports.prepareRollbackArtifact) current = await ports.prepareRollbackArtifact(current,abort.signal,assertCurrent);
          // Live data may have changed since activation. Revalidate old-code
          // readability now; never restore a pre-update database snapshot.
          await ports.validateArtifactAndCompatibility(runtimeRollbackTarget(current),current,abort.signal,assertCurrent);
          return transition('known-good-starting',{ selected: runtimeRollbackTarget(current) });
        case 'known-good-starting':
          try { await ports.validateArtifactAndCompatibility(runtimeRollbackTarget(current),current,abort.signal,assertCurrent); await ports.startHeld(runtimeRollbackTarget(current),current,abort.signal,assertCurrent); return transition('known-good-activating'); }
          catch (error) { return probeFailure(error); }
        case 'known-good-activating':
          try { await ports.validateArtifactAndCompatibility(runtimeRollbackTarget(current),current,abort.signal,assertCurrent); await ports.activate(runtimeRollbackTarget(current),current,abort.signal,assertCurrent); return transition('known-good-observing'); }
          catch (error) { return probeFailure(error); }
        case 'known-good-observing': {
          try {
            await ports.validateArtifactAndCompatibility(runtimeRollbackTarget(current),current,abort.signal,assertCurrent);
            const result = await ports.observeStartup(runtimeRollbackTarget(current),current,abort.signal,assertCurrent);
            if (result === 'healthy') return transition('rolled-back');
            if (result === 'failed') return transition('rolling-back',{ failure: 'Known-good startup failed; continue diagnosis and guarded recovery' });
            return current;
          } catch (error) { return probeFailure(error); }
        }
      }
      return current;
    } catch (error) {
      if (error instanceof RuntimeCompatibilityResample) {
        try {
          assertCurrent(); report(error);
          return ports.store.recordRuntimeUpdateResample(authority, error.message);
        } catch (recoveryError) { report(recoveryError); cancel(); throw recoveryError; }
      }
      report(error); cancel();
      throw error;
    } finally {
      (ports.cancelInterval || clearInterval)(timer);
      if (cancelling) await cancelling;
      active = undefined;
    }
  }
  return {
    reconcile(updateId: string) {
      if (!inFlight) inFlight = work(updateId).finally(() => { inFlight = undefined; });
      return inFlight;
    },
    async shutdown() {
      closed = true;
      active?.abort.abort();
      const authority = active?.authority || lastOwned;
      // A held candidate can outlive an individual reconcile call. Cancel its
      // captured generation even when no probe is currently in flight; never
      // claim exit or release the durable guard merely because shutdown ran.
      // Terminal DB state is not exit proof. The activated host remains owned
      // until a native handoff explicitly transfers it.
      const pending = inFlight;
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => authority ? ports.cancelOwned(authority) : undefined),
        pending?.catch(report) || Promise.resolve(),
      ]);
      if (cleanup[0].status === 'rejected') throw cleanup[0].reason;
    },
  };
}
