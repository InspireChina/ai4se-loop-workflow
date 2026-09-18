import {randomUUID} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {resolveNativeBootstrap} from './native-bootstrap';
import {AdminManagementStore} from './admin-management-store';
import {createNativeAdminManagement} from './native-admin-management';
import {createNativeExternalRuntime} from './native-external-runtime';
import {drainRuntimeCliRegistry} from './runtime-cli-registry';
import {inspectProcessGroup,inspectProcessIdentity,terminateProcessGroup} from './process-tree';
import type {RuntimeHostAudit} from '../domain/runtime-host-audit';
import {createExternalRuntimeControls} from '../application/external-runtime-controls';
import {createExternalRuntimeStatus} from '../application/external-runtime-status';
import {createNativeRuntimeUi} from './native-runtime-ui';
import {createExternalLifecycleAdapter} from '../application/external-lifecycle-adapter';
import type {IdleSleepInhibitor} from '../application/runtime-idle-sleep';
import {confirmWindowsJobContainmentExit} from './windows-job-containment';
import {createSingleFlight} from '../application/single-flight';

/** Shared native service composition. Its entrypoint/desktop owner can remain
 * alive while business modules execute in a separately fenced child. No Web
 * listener, business imports or invented containment/health callbacks. */
export async function createNativeExternalService(ports:{
  appRoot:string;managementRoot?:string;dataRoot:string;executable:string;electronNode?:boolean;ownerId?:string;
  signal?:AbortSignal;onError?:(error:unknown)=>void;
  inhibitIdleSleep?:IdleSleepInhibitor;
  onUiUnavailable?:(error:Error)=>void;
  /** Stable owner may persist a user stop while artifact staging is pending. */
  onStoreReady?:(store:AdminManagementStore)=>void;
}){
  for(const value of [ports.appRoot,ports.managementRoot,ports.dataRoot,ports.executable])if(value&&!isAbsolute(value))throw new Error('外部服务必须使用实际绝对路径');
  const signal=ports.signal??new AbortController().signal;signal.throwIfAborted();
  const store=new AdminManagementStore(join(ports.dataRoot,'admin-management.db'));
  try{
    ports.onStoreReady?.(store);
    const {bootstrap,installationError}=await resolveNativeBootstrap({...ports,store,signal,standardMode:true});
    const ownerId=ports.ownerId??`external-${process.pid}-${randomUUID()}`;
    const management=createNativeAdminManagement({...ports,store,rootOwnerId:ownerId,appRoot:bootstrap.root});
    let lifecycle:ReturnType<typeof createExternalLifecycleAdapter>|undefined;
    const ui=createNativeRuntimeUi({...ports,store,toolRoot:bootstrap.root,strictContainment:false,onUnavailable:(record,error)=>{
      store.assertRuntimeHost(record.authority);
      try{store.observe({observationId:`ui-exit:${record.allocationId}`,scope:'runtime',scopeKey:'desktop-ui',origin:'runtime',
        sourceVersion:record.artifact.version,fingerprint:'ui-runtime-exit',summary:error.message,
        evidence:{kind:'ui-runtime-exit',artifact:record.artifact,allocationId:record.allocationId,pid:record.pid,marker:record.marker}});}
      finally{try{ports.onUiUnavailable?.(error);}catch(reason){try{ports.onError?.(reason);}catch{/* root remains alive */}}}
    },onLifecycleRequest:async request=>{
      if(!lifecycle)throw new Error('独立界面生命周期适配器尚未初始化');
      return request.operation==='status'?lifecycle.status():lifecycle.command(request.command);
    }});
    const assertAudit=async(audit:RuntimeHostAudit,check:()=>void)=>{
      check();const roots=store.runtimeHostProcesses();
      if(!audit.databasePresent){if(roots.length)throw new Error('业务库缺失且已有宿主历史，无法证明旧写入者退出');return;}
      if(!audit.knownProtocol)throw new Error('旧业务库缺少完整进程登记协议，无法证明旧写入者退出');
      const groups=new Map<number,Promise<boolean>>();
      const groupEmpty=(groupId:number)=>{
        let pending=groups.get(groupId);
        if(!pending){pending=inspectProcessGroup(groupId).then(members=>!!members&&members.length===0);groups.set(groupId,pending);}
        return pending;
      };
      const hostEmpty=(root:typeof roots[number])=>process.platform==='win32'
        ? confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:root})
        : root.groupId?groupEmpty(root.groupId):Promise.resolve(false);
      const sourceExited=async(token:number)=>{
        // Pre-migration hosts could reuse a business token after deleting the
        // lease. Never assign their ambiguous rows to whichever exited first.
        const sources=roots.filter(row=>row.businessSupervisionToken===token);
        const root=sources.length===1&&sources[0].status==='exited'?sources[0]:undefined;
        if(!root||!store.beginRuntimeCliDrain(root.allocationId))return false;
        const [containerExited,clisExited]=await Promise.all([hostEmpty(root),drainRuntimeCliRegistry(store,root.allocationId,undefined,
          {strictContainment:false})]);
        return containerExited&&clisExited&&store.runtimeCliProcesses(root.allocationId).every(row=>row.status==='exited');
      };
      // Physical execution barriers cannot be waived by logical cancellation.
      for(const row of audit.executions){
        check();const exited=row.pid&&row.marker&&(process.platform==='win32'
          ? await confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:{allocationId:row.id,pid:row.pid,marker:row.marker}})
          : !!row.groupId&&await terminateProcessGroup(row.groupId,5000,row.marker));
        if(!exited)
          throw new Error(`旧执行进程退出未确认 allocation=${row.id}`);
      }
      for(const row of audit.managed){
        check();if(await sourceExited(row.supervisionToken))continue;
        if(row.kind==='agent-cli'){
          const execution=audit.executions.find(value=>value.pid===row.pid&&value.marker===row.marker);
          if(process.platform==='win32'&&execution&&await confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,
            process:{allocationId:execution.id,pid:execution.pid,marker:execution.marker}}))continue;
          if(execution?.groupId&&await groupEmpty(execution.groupId))continue;
          throw new Error(`旧 CLI 容器退出未确认 process=${row.id}`);
        }
        if(row.kind==='agent-runner')throw new Error(`旧 Runner 缺少已退出外部宿主来源 process=${row.id}`);
        const identity=await inspectProcessIdentity(row.pid);check();
        let alive=true;try{process.kill(row.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw error;}
        if(!alive||identity&&identity.startMarker!==row.marker)continue;
        throw new Error(`旧 UI 宿主仍存活或身份未知 process=${row.id}`);
      }
      for(const row of audit.runs){
        check();if(row.supervisionToken&&await sourceExited(row.supervisionToken))continue;
        throw new Error(`旧运行代次退出未确认 run=${row.id}`);
      }
      check();
    };
    const auditExit=async(signal:AbortSignal,check:()=>void)=>{
      const guard=()=>{check();signal.throwIfAborted();};guard();
      if(!await ui.drainPrevious(store.runtimeHostAuthority(ownerId),guard))throw new Error('旧外部界面服务实际退出未确认');
      await assertAudit(await management.inspectHosts(),guard);guard();
    };
    const root=createNativeExternalRuntime({...ports,ownerId,store,bootstrap,management,
      readLegacyStartupHealth:management.readLegacyStartupHealth,
      stopAdditionalHosts:authority=>authority?ui.cancelOwned(authority):Promise.resolve(true),
      assertUntrackedOrdinaryHostsExited:auditExit,
      confirmDescendantsExited:async record=>{
        if(store.beginRuntimeCliDrain(record.allocationId))return drainRuntimeCliRegistry(store,record.allocationId,undefined,
          {strictContainment:false});
        // Admission was never certified: no protocol CLI could be spawned.
        // Still require actual container emptiness and no unknown allocation.
        return store.runtimeCliProcesses(record.allocationId).length===0&&(process.platform==='win32'
          ? confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:record})
          : !!record.groupId&&await inspectProcessGroup(record.groupId).then(members=>!!members&&members.length===0));
      },
      confirmUntrackedHostsExited:async(_update,signal,check)=>{
        if(!await ui.drainAll(check))return false;await auditExit(signal,check);return true;
      },
    });
    let timer:NodeJS.Timeout|undefined;let closed=false;let shutdown:Promise<void>|undefined;
    const report=(error:unknown)=>{try{ports.onError?.(error);}catch{/* OS logging cannot prevent cleanup */}};
    const reconciliation=createSingleFlight(()=>root.reconcile());
    const scheduleReconciliation=()=>{
      if(closed||timer)return;
      timer=setTimeout(()=>{timer=undefined;void runReconciliation().catch(report);},10_000);timer.unref();
    };
    const runReconciliation=async()=>{
      // Keep a full quiet interval after the most recent reconciliation. A
      // fixed interval can fire immediately after a long Windows process
      // audit settles and repeatedly collide with capability cleanup.
      if(timer)clearTimeout(timer);timer=undefined;
      try{return await reconciliation.run();}finally{scheduleReconciliation();}
    };
    const command=createExternalRuntimeControls({store,
      preparePublisherUpdate:(requestId,attemptId,targetVersion)=>store.preparePublisherUpdate(store.runtimeHostAuthority(ownerId),requestId,attemptId,targetVersion),
      markPublisherUpdateReady:(requestId,revision)=>store.markPublisherUpdateReady(store.runtimeHostAuthority(ownerId),requestId,revision),
      cancelPublisherUpdate:async()=>{
        if(!store.activePublisherUpdate())return;
        const authority=store.runtimeHostAuthority(ownerId),revision=store.control().intent_revision;
        const check=()=>{store.assertRuntimeHost(authority);if(store.control().intent_revision!==revision)throw new Error('发行更新取消已被后续意图取代');};
        await root.assertStopped(check);ui.assertStopped();check();store.cancelPublisherUpdate(authority);
      },
      stopManagement:async(requestId,preparing)=>{
        const authority=store.runtimeHostAuthority(ownerId),revision=store.control().intent_revision;
        const check=()=>{store.assertRuntimeHost(authority);if(store.control().intent_revision!==revision)throw new Error('界面清理已被后续运行意图取代');};
        const results=await Promise.allSettled([Promise.resolve().then(()=>{check();return preparing?root.management.prepareUpdate(requestId):root.management.stop(requestId);}),
          Promise.resolve().then(()=>{check();return preparing?ui.drainAll(check):true;})]);
        for(const result of results)if(result.status==='rejected')report(result.reason);
      },
      stopBusiness:check=>root.stopBusiness(check),stopUpdates:check=>root.stopUpdates(check),
      reconcileIdleSleep:()=>root.management.reconcileIdleSleep(),reconcile:()=>root.reconcile(),
      assertStopped:async check=>{await root.assertStopped(check);check();if(store.control().management_mode==='update-silence')ui.assertStopped();},
    });
    const status=createExternalRuntimeStatus({control:()=>store.control(),hosts:()=>store.runtimeHostProcesses(),
      inspectBusiness:()=>management.inspectHosts(),onError:report});
    lifecycle=createExternalLifecycleAdapter({status:async()=>({...await status(),publisher:store.activePublisherUpdate(),installationError}),command});
    return {
      root,store,bootstrap,installationError,command,lifecycle,
      ui:{
        start:(port:number)=>ui.start(store.runtimeInstallation()!.artifact,store.runtimeHostAuthority(ownerId),port,signal,()=>signal.throwIfAborted()),
        stop:()=>{const authority=store.runtimeHostAuthority(ownerId);return ui.drainAll(()=>store.assertRuntimeHost(authority));},
        assertStopped:()=>{store.runtimeHostAuthority(ownerId);ui.assertStopped();},
      },
      async status(){return {...await status(),ui:store.runtimeUiProcesses(),publisher:store.activePublisherUpdate(),installationError};},
      async assertUpdateReady(){
        const authority=store.runtimeHostAuthority(ownerId),revision=store.control().intent_revision;
        const check=()=>{store.assertRuntimeHost(authority);const control=store.control();
          if(control.intent_revision!==revision||control.management_mode!=='update-silence')throw new Error('更新清理已被后续运行意图取代');};
        await root.assertStopped(check);check();ui.assertStopped();
      },
      async start(){
        if(closed)throw new Error('已关闭的外部服务不能重启');
        return runReconciliation().catch(error=>{report(error);return 'degraded';});
      },
      reconcile:()=>runReconciliation(),
      async shutdown(){
        if(shutdown)return shutdown;
        closed=true;if(timer)clearTimeout(timer);timer=undefined;
        const pending=reconciliation.current();
        shutdown=(async()=>{await root.shutdown();await pending?.catch(()=>undefined);store.close();})().catch(error=>{shutdown=undefined;throw error;});return shutdown;
      },
    };
  }catch(error){store.close();throw error;}
}
