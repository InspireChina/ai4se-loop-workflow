import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {adminBusinessRequestSchema,adminWorkerLane,parallelAdminWorker,type AdminBusinessRequest,type AdminBusinessWorkerRecord} from '../domain/admin-business-worker';
import type {AdminManagementStore} from './admin-management-store';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {inspectProcessGroup,terminateProcessGroup,waitForProcessIdentity} from './process-tree';
import {sanitizeDiagnosticText} from './diagnostic-text';
import {assertRuntimeDataOutside} from './runtime-paths';
import {RuntimeCapabilityFailure} from '../domain/runtime-original-artifact';
import type {RuntimeArtifact} from '../domain/runtime-update';
import {attachWindowsJobContainment,confirmWindowsJobContainmentExit,withWindowsJobAdmission} from './windows-job-containment';

type Handle={child?:ChildProcess;closed:Promise<void>;noSpawn:boolean;record:AdminBusinessWorkerRecord};

/** Private, serialized capability calls. No business imports in the root;
 * every physical allocation is in management storage before spawn. */
export function createNativeAdminBusinessWorker(ports:{
  store:AdminManagementStore;rootOwnerId:string;appRoot:string;dataRoot:string;executable:string;electronNode?:boolean;
  timeoutMs?:number;confirmContainmentExit?:(record:AdminBusinessWorkerRecord)=>Promise<boolean>;
  lane?:'business'|'harness-build';
}) {
  const timeoutMs=ports.timeoutMs??5000;
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('业务能力 worker 超时必须为正数');
  if(resolve(ports.store.filename)!==resolve(join(ports.dataRoot,'admin-management.db')))throw new Error('独立业务 worker 必须绑定外部 root 的管理库');
  const owned=new Map<string,Handle>();const stopping=new Map<string,Promise<boolean>>();
  const calls=new Map<AbortController,Promise<unknown>>();let serial=Promise.resolve<unknown>(undefined);
  const current=(id:string)=>{
    const record=ports.store.adminBusinessWorker(id);
    if(!record)throw new Error('业务能力 worker 分配记录丢失');return record;
  };
  const captured=(record:AdminBusinessWorkerRecord)=>owned.get(record.allocationId)?.record??record;
  async function stopRecord(captured:AdminBusinessWorkerRecord):Promise<boolean> {
    if(captured.status==='exited')return true;
    const existing=stopping.get(captured.allocationId);if(existing)return existing;
    const pending=(async()=>{
      const handle=owned.get(captured.allocationId);let record=handle?.record??captured;
      if(!handle)try{record=current(captured.allocationId);}catch{/* storage cannot suppress physical cleanup */}
      let stopped=false;
      if(!record.pid)stopped=!!handle?.noSpawn;
      else if(process.platform==='win32')stopped=ports.confirmContainmentExit
        ? !!await ports.confirmContainmentExit(record)
        : await confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:record});
      else if(record.groupId)stopped=record.marker?await terminateProcessGroup(record.groupId,5000,record.marker):
        await inspectProcessGroup(record.groupId).then(members=>!!members&&members.length===0);
      if(!stopped)return false;
      if(handle)await handle.closed;
      ports.store.confirmAdminBusinessWorkerExit(current(record.allocationId));owned.delete(record.allocationId);return true;
    })().finally(()=>stopping.delete(captured.allocationId));
    stopping.set(captured.allocationId,pending);return pending;
  }
  async function execute(request:AdminBusinessRequest,cancellation:AbortController) {
    const signal=cancellation.signal;const timer=setTimeout(()=>cancellation.abort(new Error('业务能力 worker 调用超时')),
      request.operation==='harness-build'?20*60*1000:['harness-actions','assert-runtime','runtime-business-baseline','runtime-business-progress'].includes(request.operation)?Math.max(timeoutMs,60_000):timeoutMs);
    let record:AdminBusinessWorkerRecord|undefined;let guardTimer:NodeJS.Timeout|undefined;let primary:unknown;
    let artifact:RuntimeArtifact|null= null;let selectionRevision:number|null=null;let intentRevision=0;
    try{
      signal.throwIfAborted();
      const rootAuthority=ports.store.runtimeHostAuthority(ports.rootOwnerId);
      const control=ports.store.control();intentRevision=control.intent_revision;const managementAuthority={ownerId:control.owner_id!,token:control.fencing_token};
      if(!['host-audit','runtime-business-baseline'].includes(request.operation))ports.store.assertManagementAuthority(managementAuthority);
      const installation=ports.store.runtimeInstallation();selectionRevision=installation?.revision??null;
      artifact=['host-audit','harness-actions','harness-build','assert-runtime','runtime-business-baseline','runtime-business-progress'].includes(request.operation)?ports.store.runtimeHostArtifact(rootAuthority):
        installation?.artifact??await readHarnessArtifact(ports.appRoot,{signal});
      if(!artifact)throw new Error('只读宿主诊断缺少当前 root 的实际能力代码');
      await assertRuntimeDataOutside(artifact.root,ports.dataRoot);
      if(resolve(artifact.root)!==resolve(join(ports.dataRoot,'runtime-artifacts',artifact.artifactId)))throw new Error('业务能力 worker 必须执行内容寻址的独立安装');
      signal.throwIfAborted();ports.store.assertRuntimeHost(rootAuthority);
      // A successor root must drain captured earlier allocations first. An
      // unknown PID/marker cannot be converted into positive exit evidence.
      const old=ports.store.adminBusinessWorkers(true).filter(row=>{
        if(!parallelAdminWorker(row,request.operation,rootAuthority,managementAuthority,control.intent_revision))return true;
        ports.store.assertAdminBusinessWorker(row);return false;
      });
      if(old.some(row=>row.rootAuthority.ownerId===rootAuthority.ownerId&&row.rootAuthority.token===rootAuthority.token&&!owned.has(row.allocationId)))
        throw new Error('当前 root 的其他业务能力分配退出未确认');
      const exits=await Promise.allSettled(old.map(stopRecord));
      if(exits.some(result=>result.status==='rejected'||result.value!==true))throw new Error('旧业务能力 worker 实际退出未确认');
      signal.throwIfAborted();
      const entry=join(artifact.root,'desktop-runners','admin-business-worker.cjs');
      const args=existsSync(entry)?[entry]:['--import',pathToFileURL(join(artifact.root,'node_modules','tsx','dist','loader.mjs')).href,
        join(artifact.root,'scripts','loop','admin-business-worker-entry.ts')];
      let env:NodeJS.ProcessEnv={...process.env,NODE_OPTIONS:'',NODE_PATH:'',LOOP_APP_ROOT:artifact.root,
        LOOP_DATA_ROOT:ports.dataRoot,LOOP_GLOBAL_DB_PATH:join(ports.dataRoot,'loop-ui.db')};
      for(const key of Object.keys(env))if(/^LOOP_/i.test(key)||key==='NODE_TEST_CONTEXT')delete env[key];
      Object.assign(env,{LOOP_APP_ROOT:artifact.root,LOOP_DATA_ROOT:ports.dataRoot,LOOP_GLOBAL_DB_PATH:join(ports.dataRoot,'loop-ui.db')});
      if(ports.electronNode){env.ELECTRON_RUN_AS_NODE='1';env.LOOP_DESKTOP_NODE=ports.executable;}
      else{delete env.ELECTRON_RUN_AS_NODE;delete env.LOOP_DESKTOP_NODE;}
      signal.throwIfAborted();
      record=ports.store.reserveAdminBusinessWorker(rootAuthority,managementAuthority,artifact,request);
      env=withWindowsJobAdmission(env,ports.dataRoot,record.allocationId);
      let closedResolve!:()=>void;const closed=new Promise<void>(resolve=>{closedResolve=resolve;});
      const handle:Handle={closed,noSpawn:false,record};owned.set(record.allocationId,handle);
      let child:ChildProcess;
      try{child=spawn(ports.executable,[...args,'--data-root',ports.dataRoot,'--allocation-id',record.allocationId],
        {cwd:artifact.root,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});handle.child=child;}
      catch(error){handle.noSpawn=true;closedResolve();throw error;}
      let stderr='';let replyResolve!:(value:unknown)=>void;let replyReject!:(error:unknown)=>void;
      const reply=new Promise<unknown>((resolve,reject)=>{replyResolve=resolve;replyReject=reject;});void reply.catch(()=>undefined);
      let readyResolve!:()=>void;let readyReject!:(error:unknown)=>void;
      const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>undefined);
      child.stdout!.on('data',()=>undefined);
      child.stderr!.on('data',bytes=>{stderr=(stderr+bytes.toString('utf8')).slice(-16000);});
      child.once('error',error=>{handle.noSpawn=!child.pid;readyReject(error);replyReject(error);});
      child.once('close',code=>{closedResolve();const error=new Error(`业务能力 worker 退出 code=${code}: ${sanitizeDiagnosticText(stderr)}`);readyReject(error);replyReject(error);});
      child.on('message',input=>{
        const message=input as {kind?:string;allocationId?:string;pid?:number;ok?:boolean;value?:unknown;error?:string};
        if(message?.allocationId!==record!.allocationId||message.pid!==child.pid){replyReject(new Error('业务能力 worker 私有响应身份不匹配'));readyReject(new Error('worker 身份不匹配'));return;}
        if(message.kind==='ready')readyResolve();
        else if(message.kind==='result'&&typeof message.ok==='boolean')message.ok?replyResolve(message.value):replyReject(new Error(sanitizeDiagnosticText(message.error||'业务能力执行失败')));
        else replyReject(new Error('未知业务能力 worker 私有响应'));
      });
      const abort=()=>{readyReject(signal.reason);replyReject(signal.reason);void stopRecord(handle.record).catch(()=>undefined);};
      signal.addEventListener('abort',abort,{once:true});
      try{
        if(!child.pid){await closed;await ready;throw new Error('业务能力 worker 未分配实际 PID');}
        if(!await attachWindowsJobContainment({dataRoot:ports.dataRoot,allocationId:record.allocationId,pid:child.pid}))
          throw new Error('业务能力 worker 无法进入 Windows Job 容器');
        handle.record={...record,pid:child.pid,groupId:process.platform!=='win32'?child.pid:null};
        ports.store.bindAdminBusinessWorker(record,child.pid,undefined,handle.record.groupId??undefined);
        const identity=await waitForProcessIdentity(child.pid,{timeoutMs:1000});
        if(identity){handle.record={...handle.record,marker:identity.startMarker,status:'bound'};
          ports.store.bindAdminBusinessWorker(record,child.pid,identity.startMarker,handle.record.groupId??undefined);}
        if(!identity)throw new Error('业务能力 worker 缺少实际启动身份');
        guardTimer=setInterval(()=>{try{ports.store.assertAdminBusinessWorker(current(record!.allocationId));}catch(error){cancellation.abort(error);}},100);
        if(signal.aborted)abort();await ready;signal.throwIfAborted();
        ports.store.assertAdminBusinessWorker(current(record.allocationId));
        child.send!({kind:'perform',allocationId:record.allocationId,request},error=>{if(error)replyReject(error);});
        const result=await reply;signal.throwIfAborted();ports.store.assertAdminBusinessWorker(current(record.allocationId));return result;
      }finally{signal.removeEventListener('abort',abort);}
    }catch(error){primary=artifact?new RuntimeCapabilityFailure(error,artifact,selectionRevision,request.operation,intentRevision):error;throw primary;}
    finally{
      clearTimeout(timer);if(guardTimer)clearInterval(guardTimer);
      if(record){
        let stopped=false;let cleanup:unknown;
        try{stopped=await stopRecord(captured(record));}catch(error){cleanup=error;}
        if(!stopped){
          const error=new AggregateError([...(primary?[primary]:[]),cleanup??new Error('业务能力 worker 实际退出未确认')],'保留业务能力 worker 退出屏障和原始诊断');
          throw artifact?new RuntimeCapabilityFailure(error,artifact,selectionRevision,request.operation,intentRevision):error;
        }
      }
    }
  }
  return {
    async drainPrevious(){
      const root=ports.store.runtimeHostAuthority(ports.rootOwnerId);
      const control=ports.store.control(),management={ownerId:control.owner_id!,token:control.fencing_token};
      const records=ports.store.adminBusinessWorkers(true).filter(record=>{
        if(owned.has(record.allocationId))return false;
        if(!parallelAdminWorker(record,ports.lane==='harness-build'?'harness-build':'discover',root,management,control.intent_revision))return true;
        ports.store.assertAdminBusinessWorker(record);return false;
      });
      if(records.some(record=>record.rootAuthority.ownerId===root.ownerId&&record.rootAuthority.token===root.token))
        throw new Error('当前 root 的其他业务能力分配退出未确认');
      const results=await Promise.allSettled(records.map(stopRecord));
      ports.store.assertRuntimeHost(root);
      if(results.some(result=>result.status==='rejected'||result.value!==true))throw new Error('旧业务能力 worker 实际退出未确认');
    },
    run(input:AdminBusinessRequest):Promise<unknown>{
      const request=adminBusinessRequestSchema.parse(input);const cancellation=new AbortController();
      if(adminWorkerLane(request.operation)!==(ports.lane??'business'))throw new Error('能力调用不能跨越绑定的构建 / 诊断通道');
      const next=serial.catch(()=>undefined).then(()=>execute(request,cancellation));serial=next;
      calls.set(cancellation,next);void next.finally(()=>calls.delete(cancellation)).catch(()=>undefined);return next;
    },
    async stopOwned(){
      const pending=[...calls.entries()];for(const [controller] of pending)controller.abort(new Error('管理停止或外部 root 失效'));
      const records=[...owned.values()].map(handle=>handle.record);
      const results=await Promise.allSettled(records.map(stopRecord));
      await Promise.allSettled(pending.map(([,call])=>call));
      if(results.some(result=>result.status==='rejected'||result.value!==true)||owned.size)
        throw new Error('独立业务能力 worker 退出未确认，保留管理宿主所有权');
    },
  };
}
