import type {RuntimeArtifact,RuntimeHostProcess,RuntimeUpdateProcess,RuntimeUpdateRecord} from '../domain/runtime-update';
import type {AdminManagementStore} from './admin-management-store';
import {createExternalRuntimeHost} from '../application/external-runtime-host';
import {createExternalRuntimeFailureReporter} from '../application/external-runtime-failure';
import {createRuntimeUpdateController} from '../application/runtime-update-controller';
import {createNativeRuntimeHost} from './native-runtime-host';
import {createNativeRuntimeUpdate,type LegacyStartupHealthReader} from './native-runtime-update';
import {createRuntimeDatabaseCompatibility} from './runtime-database-compatibility';
import {join,resolve} from 'node:path';
import {createAdminController,type AdminControllerPorts} from '../application/admin-controller';
import type {RuntimeHostAuthority} from '../domain/runtime-update';
import {createRuntimeIdleSleep,type IdleSleepInhibitor} from '../application/runtime-idle-sleep';
import {createNativeIdleSleepInhibitor} from './idle-sleep-inhibitor';
export {AdminManagementStore} from './admin-management-store';
// Stable external entrypoints must be able to compose the configured Admin
// launcher from this independent bundle, not import the business lifecycle
// bundle merely to obtain an invocation adapter.
export {createConfiguredAdminExecution} from '../application/admin-configured-execution';
export {createAdminExecutionLauncher,confirmAdminAttemptStopped} from './admin-execution';
export {createLangfuseTelemetry} from './langfuse';
export {createNativeAdminManagement} from './native-admin-management';
export {createNativeAdminBusinessWorker} from './native-admin-business-worker';
export {createNativeExternalService} from './native-external-service';

/** Native composition exported independently from business code. It keeps
 * required process/health proof ports explicit; it never infers success from
 * empty root records or an Agent's summary. The owner supplies an immutable
 * staged bootstrap, not an installer/cache directory that changes in place. */
export function createNativeExternalRuntime(ports:{
  store:AdminManagementStore;ownerId:string;dataRoot:string;executable:string;electronNode?:boolean;bootstrap:RuntimeArtifact;
  /** Independent configured launcher/capability ports. Mandatory: native
   * root startup cannot silently omit management scheduling. Business storage
   * capabilities must remain out-of-process at this boundary. */
  management:Omit<AdminControllerPorts,'store'|'ownerId'>&{
    freezeRuntimeBusinessBaseline?:(update:RuntimeUpdateRecord,signal:AbortSignal,check:()=>void)=>Promise<void>};
  inhibitIdleSleep?:IdleSleepInhibitor;
  /** Desktop UI is separately owned; failed physical cleanup retains root lease. */
  stopAdditionalHosts?:(authority:RuntimeHostAuthority|undefined)=>Promise<boolean>;
  confirmDescendantsExited:(record:RuntimeHostProcess)=>Promise<boolean>;
  confirmUntrackedHostsExited:(update:RuntimeUpdateRecord,signal:AbortSignal,check:()=>void)=>Promise<boolean>;
  verifyStartup?:(artifact:RuntimeArtifact,record:RuntimeUpdateProcess,signal:AbortSignal,check:()=>void)=>Promise<void>;
  readLegacyStartupHealth?:LegacyStartupHealthReader;
  assertUntrackedOrdinaryHostsExited?:(signal:AbortSignal,check:()=>void)=>Promise<void>;
  confirmContainmentExit?:(record:RuntimeHostProcess|RuntimeUpdateProcess)=>Promise<boolean>;
  confirmReaderContainmentExit?:(pid:number,marker:string|null)=>Promise<boolean>;
  onError?:(error:unknown)=>void;
}) {
  if(!ports.management?.launch||!ports.management.confirmStopped)throw new Error('原生外部 root 必须配置独立 Admin 启动与实际退出能力');
  if(resolve(ports.bootstrap.root)!==resolve(join(ports.dataRoot,'runtime-artifacts',ports.bootstrap.artifactId)))throw new Error('外部宿主 bootstrap 必须是独立内容寻址安装快照');
  const compatibility=createRuntimeDatabaseCompatibility({dataRoot:ports.dataRoot,executable:ports.executable,electronNode:ports.electronNode,
    confirmContainmentExit:ports.confirmReaderContainmentExit});
  let nativeUpdate:ReturnType<typeof createNativeRuntimeUpdate>;
  const normal=createNativeRuntimeHost({...ports,drainUpdates:async check=>{
    check();const authorities=new Map(ports.store.liveRuntimeUpdateProcesses().map(record=>
      [JSON.stringify(record.authority),record.authority]));
    // Captured allocations only; do not rescan and kill a successor during
    // shutdown. This path runs under the root/selection check before startup.
    const results=await Promise.allSettled([
      Promise.resolve().then(()=>compatibility.stopOwned()),
      ...[...authorities.values()].map(authority=>nativeUpdate.cancelOwned(authority)),
    ]);
    check();return results.every(result=>result.status==='fulfilled'&&(result.value===true||result.value===undefined))
      &&ports.store.liveRuntimeUpdateProcesses().length===0;
  }});
  nativeUpdate=createNativeRuntimeUpdate({...ports,validateCompatibility:compatibility,
    freezeBusinessBaseline:ports.management.freezeRuntimeBusinessBaseline,confirmOldHostsStopped:async(update,signal,check)=>{
    check();const results=await Promise.allSettled([
      normal.drainAll(check),Promise.resolve().then(()=>ports.confirmUntrackedHostsExited(update,signal,check)),
    ]);
    check();return results.every(result=>result.status==='fulfilled'&&result.value===true);
  }});
  const updates=createRuntimeUpdateController({...ports,...nativeUpdate});
  const reportFailure=createExternalRuntimeFailureReporter(ports.store,ports.ownerId);
  let rootAuthority:RuntimeHostAuthority|undefined;
  const assertRoot=()=>{if(!rootAuthority)throw new Error('Admin 外部 root 尚未取得所有权');ports.store.assertRuntimeHost(rootAuthority);};
  const guardedLaunch=(launch:AdminControllerPorts['launch']):AdminControllerPorts['launch']=>async(claim,bind,signal)=>{
    try{assertRoot();}catch(error){
      // This port has not been called; positive pre-spawn failure must not
      // create an unknown-PID orphan during root fencing.
      return {completion:Promise.resolve({outcome:'failed',exitConfirmed:true,reason:error instanceof Error?error.message:String(error)}),stop:async()=>true};
    }
    return launch(claim,(...args)=>{bind(...args);assertRoot();},signal);
  };
  const management=createAdminController({...ports.management,store:ports.store,ownerId:`${ports.ownerId}:management`,
    onError:error=>{
      for(const sink of new Set([ports.management.onError,ports.onError]))try{sink?.(error);}catch{/* diagnostics cannot block cleanup */}
    },
    launch:guardedLaunch(ports.management.launch),
    ...(ports.management.launchVerification?{launchVerification:guardedLaunch(ports.management.launchVerification)}:{}),
    discover:async()=>{assertRoot();const result=await ports.management.discover?.();assertRoot();return result;},
    manageActions:async authority=>{assertRoot();const result=await ports.management.manageActions?.(authority);assertRoot();return result;},
    manageFollowups:async authority=>{assertRoot();const result=await ports.management.manageFollowups?.(authority);assertRoot();return result;},
  });
  const idleSleep=createRuntimeIdleSleep({readKey:()=>{
    const control=ports.store.control();
    return rootAuthority&&ports.store.isRuntimeHostCurrent(rootAuthority)&&control.desired_intent==='running'
      &&control.management_mode==='normal'&&control.owner_id===`${ports.ownerId}:management`&&control.expires_at>Date.now()
      ?`${rootAuthority.token}:${control.intent_revision}:${control.fencing_token}`:null;
  },acquire:ports.inhibitIdleSleep??createNativeIdleSleepInhibitor(),onError:error=>{
    try{ports.onError?.(error);}catch{/* OS diagnostics cannot disable management */}
  }});
  const host=createExternalRuntimeHost({...ports,...normal,updates,onFailure:failure=>{reportFailure(failure);},
    management:{start:async authority=>{
      rootAuthority=authority;
      if(!ports.store.runtimeHostArtifact(authority)){
        await normal.validateInstalled(ports.bootstrap,new AbortController().signal,assertRoot);
        assertRoot();ports.store.bindRuntimeHostArtifact(authority,ports.bootstrap);
      }
      // A new installer/bootstrap is not itself permission to replace the
      // selected business artifact. Only a physically-ready persisted
      // publisher request can enter the normal external update transaction.
      assertRoot();ports.store.beginPublisherInstallation(authority,ports.bootstrap);assertRoot();
      // A directly launched installer never had an old UI process available
      // to create publisher readiness. Convert that verified version mismatch
      // into the same guarded update protocol before any old business host is
      // admitted, otherwise an unfixed cached runtime can deadlock its own
      // migration and prevent the new release from ever becoming selected.
      ports.store.beginInstalledBootstrapTransition(authority,ports.bootstrap);assertRoot();
      let [result]=await Promise.all([management.start(),idleSleep.start()]);
      if(result==='observer'){
        // An older business host may still own the previous management lease,
        // or serialized capability preparation may still be draining a
        // predecessor. Drain the captured native host first, then retry;
        // never let a fresh business child win either startup race.
        if(!await normal.drainAll(()=>ports.store.assertRuntimeHost(authority)))return 'observer';
        result=await management.reconcile();
      }
      await idleSleep.reconcile();return result;
    },shutdown:async()=>{
      const results=await Promise.allSettled([management.shutdown(),idleSleep.shutdown(),Promise.resolve().then(async()=>{
        if(ports.stopAdditionalHosts&&!await ports.stopAdditionalHosts(rootAuthority))throw new Error('额外宿主实际退出未确认');
      })]);
      const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
      if(errors.length)throw new AggregateError(errors,'外部管理宿主与防休眠资源退出尚未完成');
    }},
  });
  return {...host,normal,updates,management:{
    reconcile:()=>{assertRoot();return management.reconcile();},
    waitForSettlements:()=>management.waitForSettlements(),
    stop:(requestId:string)=>{assertRoot();return management.stop(requestId);},
    prepareUpdate:(requestId:string)=>{assertRoot();return management.prepareUpdate(requestId);},
    reconcileIdleSleep:()=>idleSleep.reconcile(),
  },
  stopBusiness:(check:()=>void=()=>undefined)=>{const guard=()=>{assertRoot();check();};guard();return normal.drainAll(guard);},
  async stopUpdates(check:()=>void=()=>undefined){
    assertRoot();check();
    const authorities=new Map(ports.store.liveRuntimeUpdateProcesses()
      .map(record=>[JSON.stringify(record.authority),record.authority]));
    const results=await Promise.allSettled([
      Promise.resolve().then(()=>compatibility.stopOwned()),
      ...[...authorities.values()].map(authority=>nativeUpdate.cancelOwned(authority)),
    ]);
    const failures=results.filter(result=>result.status==='rejected'||result.value!==true&&result.value!==undefined);
    if(failures.length)throw new AggregateError(failures.flatMap(result=>result.status==='rejected'?[result.reason]:[]),'更新宿主或读者实际退出未确认');
    assertRoot();check();
  },
  async assertStopped(check:()=>void){
    assertRoot();check();
    if(ports.store.runtimeHostProcesses().some(record=>record.status!=='exited'
      ||ports.store.runtimeCliProcesses(record.allocationId).some(cli=>cli.status!=='exited'))
      ||ports.store.liveRuntimeUpdateProcesses().length||ports.store.adminBusinessWorkers(true).length
      ||ports.store.attempts().some(attempt=>['launching','running'].includes(attempt.status))) {
      throw new Error('持久化进程屏障仍有未确认退出的宿主、CLI、Admin 或诊断读者');
    }
    check();
  }};
}
