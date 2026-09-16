import type { AdminControllerPorts } from '../application/admin-controller';
import type { AdminManagementStore } from './admin-management-store';
import { createNativeAdminVerification } from './native-admin-verification';
import { sanitizeDiagnosticText } from './diagnostic-text';
import { boundedExecutionLookup } from '../application/bounded-execution-lookup';
import { independentPreparationHash, type IndependentVerificationInput } from '../domain/independent-verification-preparation';
import { assertVerificationArtifacts } from './verification-artifacts';

/** Plan preparation and native execution are distinct durable generations.
 * They share the independent management slot, never an ordinary business slot.
 * A saved preparation is not a verification receipt or authority to hand back. */
export function createDefaultRepairVerification(ports: {
  store: AdminManagementStore; appRoot: string; prepare: AdminControllerPorts['launch'];
  assertWorkspace?: (caseId: string, input: IndependentVerificationInput) => Promise<void>;
}): AdminControllerPorts['launch'] {
  const checkInputs = async (claim: Parameters<AdminControllerPorts['launch']>[0], signal: AbortSignal) => {
    const prepared = ports.store.preparedVerificationPlan(claim);
    if (!prepared) throw new Error('独立验收准备来源丢失');
    const current = ports.store.independentVerificationInput(claim);
    if(current.kind==='runtime' && ports.assertWorkspace)await boundedExecutionLookup(()=>ports.assertWorkspace!(claim.repairCase.caseId,current),signal,60_000,'Independent runtime candidate check');
    await assertVerificationArtifacts(prepared.artifacts, { workspaceRoot: prepared.workspaceRoot, signal,
      assertCurrent: () => { ports.store.assertIndependentVerificationClaim(claim); } });
  };
  const execute = createNativeAdminVerification({ store: ports.store, appRoot: ports.appRoot,
    assertCheckInputs: checkInputs, resolvePlan: async claim => {
    const prepared = ports.store.preparedVerificationPlan(claim);
    if (!prepared) throw new Error('原始契约独立验收计划缺失或来源已变化');
    return prepared;
  } });
  return async (claim, bind, signal) => {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let prepared;
    let source: IndependentVerificationInput;
    const guard = async () => {
      cancellation.signal.throwIfAborted();
      const current = ports.store.independentVerificationInput(claim);
      if (source && independentPreparationHash(source) !== independentPreparationHash(current)) throw new Error('独立验收冻结来源已变化');
      if (ports.assertWorkspace) await boundedExecutionLookup(() => ports.assertWorkspace!(claim.repairCase.caseId, current),
        cancellation.signal, current.kind==='runtime'?60_000:5000, 'Independent workspace ownership check');
    };
    try {
      source = ports.store.independentVerificationInput(claim);
      await guard();
      prepared = ports.store.preparedVerificationPlan(claim);
      if (prepared) await checkInputs(claim, cancellation.signal);
    }
    catch (error) {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) {
        try { ports.store.recordVerificationSourceLoss(claim, sanitizeDiagnosticText(String(error))); }
        catch { /* A stale owner cannot mutate the Case. No child was launched. */ }
      }
      return { completion: Promise.resolve({ outcome: 'failed', exitConfirmed: true,
        reason: sanitizeDiagnosticText(String(error)) }), stop: async () => true };
    }
    let checking = false;
    let guardFlight: Promise<void> | undefined;
    let guardFailure: string | undefined;
    const timer = ports.assertWorkspace ? setInterval(() => {
      if (checking || cancellation.signal.aborted) return;
      checking = true;
      guardFlight = guard().catch(error => {
        if (signal.aborted) return;
        guardFailure ||= sanitizeDiagnosticText(String(error));
        cancellation.abort(error);
      }).finally(() => { checking = false; });
    }, 1000) : undefined;
    const clean = () => { if (timer) clearInterval(timer); signal.removeEventListener('abort', abort); };
    try {
      const handle = await (prepared ? execute : ports.prepare)(claim, bind, cancellation.signal);
      return { stop: async () => { abort(); return handle.stop(); }, completion: handle.completion.then(async result => {
        if (timer) clearInterval(timer);
        await guardFlight; // no delayed ownership check may outlive settlement
        if (!guardFailure && !signal.aborted && !cancellation.signal.aborted) {
          try { await guard(); if (prepared) await checkInputs(claim, cancellation.signal); }
          catch (error) { guardFailure = sanitizeDiagnosticText(String(error)); }
        }
        if (guardFailure && !signal.aborted) {
          ports.store.recordVerificationSourceLoss(claim, guardFailure);
          return { ...result, outcome: 'failed' as const, reason: guardFailure };
        }
        return result;
      }).finally(clean) };
    } catch (error) {
      cancellation.abort(error); clean(); throw error; // unknown launch is not physical exit proof
    }
  };
}
