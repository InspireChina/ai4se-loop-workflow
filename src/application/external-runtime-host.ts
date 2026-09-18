import type {AdminManagementStore} from '../infrastructure/admin-management-store';
import type {RuntimeArtifact,RuntimeHostAuthority} from '../domain/runtime-update';

export type ExternalRuntimeFailure = {
  error:unknown;stage:'selection'|'validation'|'startup';artifact:RuntimeArtifact;
  authority:RuntimeHostAuthority;intentRevision:number;selectionRevision:number|null;
};

/** Stable external root orchestration. It never imports selected business
 * code into its own process. Native ports must own durable process records;
 * owner lease expiry/cancel alone is never physical exit proof. */
export function createExternalRuntimeHost(ports:{
  store:Pick<AdminManagementStore,'control'|'runtimeInstallation'|'initializeRuntimeInstallation'|'activeRuntimeUpdate'|'acquireRuntimeHost'|'assertRuntimeHost'|'renewRuntimeHost'|'releaseRuntimeHost'>;
  ownerId:string;bootstrap:RuntimeArtifact;
  validateInstalled:(artifact:RuntimeArtifact,signal:AbortSignal,check:()=>void)=>Promise<void>;
  ensureSelected:(artifact:RuntimeArtifact,authority:RuntimeHostAuthority,signal:AbortSignal,check:()=>void)=>Promise<void>;
  drainNormal:(authority:RuntimeHostAuthority,check:()=>void)=>Promise<boolean>;
  updates:{reconcile:(updateId:string)=>Promise<unknown>;shutdown:()=>Promise<void>};
  cancelOwned:(authority:RuntimeHostAuthority)=>Promise<boolean>;
  management?:{start:(authority:RuntimeHostAuthority)=>Promise<unknown>;settled?:(state:'hosting'|'updating'|'failed')=>void;shutdown:()=>Promise<void>};
  onError?:(error:unknown)=>void;
  onFailure?:(failure:ExternalRuntimeFailure)=>void;
  scheduleInterval?:(callback:()=>void,ms:number)=>NodeJS.Timeout;cancelInterval?:(timer:NodeJS.Timeout)=>void;
}) {
  let authority:RuntimeHostAuthority|undefined;let active:AbortController|undefined;let timer:NodeJS.Timeout|undefined;
  let pending:Promise<'observer'|'updating'|'hosting'>|undefined;let shutdown:Promise<void>|undefined;let closed=false;
  const report=(error:unknown)=>{try{ports.onError?.(error);}catch{/* diagnostics cannot stop fencing */}};
  const managementSettled=(state:'hosting'|'updating'|'failed')=>{try{ports.management?.settled?.(state);}catch(error){report(error);}};
  const assertHost=()=>{if(closed||!authority)throw new Error('外部宿主已停止');ports.store.assertRuntimeHost(authority);};
  const check=()=>{assertHost();if(active?.signal.aborted)throw new Error('外部宿主操作已取消');};
  const cancel=async()=>{
    active?.abort();
    const captured=authority;
    const results=await Promise.allSettled([
      Promise.resolve().then(()=>ports.updates.shutdown()),
      Promise.resolve().then(()=>captured?ports.cancelOwned(captured):true),
      Promise.resolve().then(()=>ports.management?.shutdown()),
    ]);
    for(const result of results)if(result.status==='rejected')report(result.reason);
    return results.every(result=>result.status==='fulfilled')&&results[1].status==='fulfilled'&&results[1].value===true;
  };
  async function work():Promise<'observer'|'updating'|'hosting'> {
    if(closed)throw new Error('已关闭的外部宿主不能启动');
    if(!authority)authority=ports.store.acquireRuntimeHost(ports.ownerId)||undefined;
    if(!authority)return 'observer';
    active=new AbortController();
    let intentRevision:number|undefined;let ordinary=false;
    let artifact=ports.bootstrap;let stage:ExternalRuntimeFailure['stage']='selection';let selectionRevision:number|null=null;
    if(!timer) {
      timer=(ports.scheduleInterval||setInterval)(()=>{
        try{assertHost();if(!ports.store.renewRuntimeHost(authority!))throw new Error('外部宿主续租失败');}
        catch(error){report(error);closed=true;active?.abort();if(timer)(ports.cancelInterval||clearInterval)(timer);timer=undefined;void cancel().catch(report);}
      },1000);timer.unref();
    }
    try {
      // Root-owned management is installed before importing/starting the
      // selected business host, and is not shut down on business failure.
      const managementState=await ports.management?.start(authority);check();
      check();intentRevision=ports.store.control().intent_revision;const updating=ports.store.activeRuntimeUpdate();
      if(updating) {
        // No ordinary root is started alongside a held update generation.
        if(!await ports.drainNormal(authority,check)){managementSettled('updating');return 'updating';}check();
        await ports.updates.reconcile(updating.request.updateId);check();managementSettled('updating');return 'updating';
      }
      if(ports.store.control().management_mode!=='normal') {
        // Publisher preparation is also an admission barrier even before an
        // automatic RuntimeUpdate exists. Do not recreate an ordinary host
        // behind a ready-for-update receipt on the next periodic tick.
        await ports.drainNormal(authority,check);check();managementSettled('updating');return 'updating';
      }
      if(managementState==='observer')return 'observer';
      ordinary=true;
      let selected=ports.store.runtimeInstallation();
      let selectionValidated=false;
      if(!selected) {
        stage='validation';
        await ports.validateInstalled(ports.bootstrap,active.signal,check);check();
        // Another authorized writer may have installed a selection while the
        // bootstrap hash was read. Never overwrite that winner.
        selected=ports.store.runtimeInstallation()||ports.store.initializeRuntimeInstallation(ports.bootstrap);
        selectionValidated=JSON.stringify(selected.artifact)===JSON.stringify(ports.bootstrap);
      }
      const revision=selected.revision;artifact=selected.artifact;selectionRevision=revision;
      const assertSelection=()=>{
        check();if(ports.store.control().management_mode!=='normal'||ports.store.activeRuntimeUpdate()||ports.store.runtimeInstallation()?.revision!==revision)throw new Error('启动期间安装选择或更新门禁已变化');
      };
      stage='validation';if(!selectionValidated)await ports.validateInstalled(artifact,active.signal,assertSelection);assertSelection();
      stage='startup';
      await ports.ensureSelected(artifact,authority,active.signal,assertSelection);assertSelection();managementSettled('hosting');return 'hosting';
    }catch(error){
      report(error);
      // Stop/fence/selection changes are not runtime faults. Recording facts
      // cannot postpone physical cleanup or turn cancellation into a retry.
      try {
        assertHost();const control=ports.store.control();
        if(ordinary&&intentRevision!==undefined&&!active.signal.aborted&&control.desired_intent==='running'&&control.management_mode==='normal'
          &&control.intent_revision===intentRevision&&!ports.store.activeRuntimeUpdate()
          &&(selectionRevision===null||ports.store.runtimeInstallation()?.revision===selectionRevision))
          ports.onFailure?.({error,stage,artifact,authority,intentRevision,selectionRevision});
      }catch(diagnosticError){report(diagnosticError);}
      active.abort();await Promise.resolve().then(()=>ports.cancelOwned(authority!)).catch(report);managementSettled('failed');throw error;
    }
    finally {active=undefined;}
  }
  return {
    reconcile(){if(!pending)pending=work().finally(()=>{pending=undefined;});return pending;},
    shutdown(){
      if(!shutdown)shutdown=(async()=>{
        closed=true;active?.abort();if(timer)(ports.cancelInterval||clearInterval)(timer);timer=undefined;
        const exited=await cancel();await pending?.catch(report);
        if(!exited)throw new Error('外部宿主受管进程退出未确认，保留所有权屏障');
        if(authority)ports.store.releaseRuntimeHost(authority);
      })().catch(error=>{shutdown=undefined;throw error;});return shutdown;
    },
  };
}
