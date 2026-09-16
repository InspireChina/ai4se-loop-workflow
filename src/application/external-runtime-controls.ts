import type { AdminManagementStore } from '../infrastructure/admin-management-store';
import { sanitizeDiagnosticText } from '../infrastructure/diagnostic-text';

export type ExternalRuntimeControlAction =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'prepare-update';attemptId?:string;targetVersion?:string }
  | { kind: 'resume-after-update' };
export type ExternalRuntimeControlReceipt = {
  requestId: string;
  revision: number;
  outcome: 'accepted' | 'stopped' | 'ready-for-update' | 'update-in-progress' | 'cleanup-pending' | 'superseded';
  intent: 'running' | 'stopped';
  mode: 'normal' | 'update-silence';
  failures: string[];
};

/** Shared desktop/standalone protocol. Commit admission barriers first, then
 * attempt every physical cleanup independently. A durable state or a killed
 * root alone is not a ready-for-update receipt. No business storage imports. */
export function createExternalRuntimeControls(ports: {
  store: Pick<AdminManagementStore, 'control' | 'intentCommand' | 'setIntent' | 'setUpdateSilence' | 'activeRuntimeUpdate'>;
  stopManagement: (requestId: string, preparingUpdate: boolean) => Promise<void>;
  stopBusiness: (check: () => void) => Promise<boolean>;
  stopUpdates: (check: () => void) => Promise<void>;
  reconcileIdleSleep: () => Promise<void>;
  reconcile: () => Promise<unknown>;
  assertStopped: (check: () => void) => Promise<void>;
  preparePublisherUpdate?:(requestId:string,attemptId:string,targetVersion:string)=>number;
  markPublisherUpdateReady?:(requestId:string,revision:number)=>void;
  cancelPublisherUpdate?:()=>Promise<void>;
}) {
  const receipt = (requestId: string, revision: number, outcome: ExternalRuntimeControlReceipt['outcome'], failures: string[] = []): ExternalRuntimeControlReceipt => {
    const control = ports.store.control();
    return { requestId, revision, outcome, intent: control.desired_intent, mode: control.management_mode, failures };
  };
  return async (requestId: string, action: ExternalRuntimeControlAction): Promise<ExternalRuntimeControlReceipt> => {
    if (!requestId.trim()) throw new Error('运行控制必须提供请求标识');
    const publisher=action.kind==='prepare-update'&&(action.attemptId!==undefined||action.targetVersion!==undefined);
    if(publisher&&(!action.attemptId?.trim()||!action.targetVersion?.trim()||!ports.preparePublisherUpdate))throw new Error('发行更新必须提供完整目标及独立持久化能力');
    const prior=ports.store.intentCommand(requestId);
    const expectedAction=action.kind==='prepare-update'?'update-silence':action.kind==='start'?'running':action.kind==='stop'?'stopped':'resume-after-update';
    if(prior&&prior.action!==expectedAction)throw new Error('同一运行控制请求不能改变动作');
    if(prior&&prior.revision!==ports.store.control().intent_revision)return receipt(requestId,prior.revision,'superseded');
    if ((action.kind === 'start' && ports.store.control().management_mode !== 'normal')
      || (['start', 'prepare-update', 'resume-after-update'].includes(action.kind) && ports.store.activeRuntimeUpdate())) {
      return receipt(requestId, ports.store.control().intent_revision, 'update-in-progress');
    }
    const stopping = action.kind === 'stop' || action.kind === 'prepare-update';
    if(action.kind==='resume-after-update')await ports.cancelPublisherUpdate?.();
    const revision = action.kind === 'prepare-update' ? publisher
      ? ports.preparePublisherUpdate!(requestId,action.attemptId!,action.targetVersion!) : ports.store.setUpdateSilence(true, requestId)
      : action.kind === 'resume-after-update' ? ports.store.setUpdateSilence(false, requestId)
      : ports.store.setIntent(action.kind === 'start' ? 'running' : 'stopped', requestId);
    // Replaying an obsolete request must not perform another generation's
    // physical actions, restart work, or declare current cleanup successful.
    if (ports.store.control().intent_revision !== revision) return receipt(requestId, revision, 'superseded');
    const check = () => {
      if (ports.store.control().intent_revision !== revision) throw new Error('运行控制请求已被后续意图取代');
    };
    const operations = stopping ? [
      () => ports.stopManagement(requestId, action.kind === 'prepare-update'),
      async () => { if (!await ports.stopBusiness(check)) throw new Error('业务宿主或 CLI 后代实际退出未确认'); },
      () => ports.stopUpdates(check),
      () => ports.reconcileIdleSleep(),
    ] : [() => ports.reconcile(), () => ports.reconcileIdleSleep()];
    const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(() => { check(); return operation(); })));
    const failures = results.flatMap(result => result.status === 'rejected'
      ? [sanitizeDiagnosticText(result.reason instanceof Error ? result.reason.message : String(result.reason))] : []);
    if (stopping && ports.store.control().intent_revision === revision) {
      try { await ports.assertStopped(check);check();if(action.kind==='prepare-update')ports.markPublisherUpdateReady?.(requestId,revision); }
      catch (error) { failures.push(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))); }
    }
    if (ports.store.control().intent_revision !== revision) return receipt(requestId, revision, 'superseded', failures);
    return receipt(requestId, revision, failures.length ? 'cleanup-pending'
      : action.kind === 'prepare-update' ? 'ready-for-update' : stopping ? 'stopped' : 'accepted', failures);
  };
}
