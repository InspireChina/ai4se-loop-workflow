import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readHarnessArtifact } from '../../scripts/harness-artifact.mjs';
import type { AdminManagementStore } from './admin-management-store';
import type { RuntimeArtifact, RuntimeUpdateAuthority, RuntimeUpdateProcess, RuntimeUpdateRecord } from '../domain/runtime-update';
import { inspectProcessGroup, terminateProcessGroup, terminateProcessTree, waitForProcessIdentity } from './process-tree';
import { sanitizeDiagnosticText } from './diagnostic-text';
import {assertRuntimeDataOutside} from './runtime-paths';
import {assertHeldHostHealth} from '../domain/runtime-host-health';
import {attachWindowsJobContainment,confirmWindowsJobContainmentExit,withWindowsJobAdmission} from './windows-job-containment';

type Check = () => void;
type Owned = { child: ChildProcess; ready: Promise<void>; closed: Promise<void>; stop: () => Promise<boolean>;
  rpc: (authority: RuntimeUpdateAuthority, signal: AbortSignal,probe?:boolean) => Promise<unknown>; activated: boolean; healthProtocol:unknown };
export type LegacyStartupHealthReader=((record:RuntimeUpdateProcess,signal:AbortSignal,check:Check)=>Promise<unknown>)
  &{stopOwned?:()=>Promise<boolean>};

/** Real private IPC/process adapter, independent of business dispatch. The
 * compatibility port is REQUIRED: a source hash is not DB rollback proof. */
export function createNativeRuntimeUpdate(ports: {
  store: AdminManagementStore; dataRoot: string; executable: string; electronNode?: boolean;
  validateCompatibility: ((artifact: RuntimeArtifact, update: RuntimeUpdateRecord, signal: AbortSignal, assertCurrent: Check) => Promise<void>)
    & {stopOwned?:(authority?:RuntimeUpdateAuthority)=>Promise<boolean>};
  confirmOldHostsStopped: (update: RuntimeUpdateRecord, signal: AbortSignal, assertCurrent: Check) => Promise<boolean>;
  freezeBusinessBaseline?: (update:RuntimeUpdateRecord,signal:AbortSignal,assertCurrent:Check)=>Promise<void>;
  /** Omission uses fresh, version-bound private lifecycle health RPC. */
  verifyStartup?: (artifact: RuntimeArtifact, process: RuntimeUpdateProcess, signal: AbortSignal, assertCurrent: Check) => Promise<void>;
  readLegacyStartupHealth?:LegacyStartupHealthReader;
  /** Native Windows Job/guardian proof; child close alone cannot supply it. */
  confirmContainmentExit?: (process: RuntimeUpdateProcess) => Promise<boolean>;
  startupTimeoutMs?: number;
}) {
  if (!isAbsolute(ports.dataRoot)||!isAbsolute(ports.executable))throw new Error('外部宿主路径必须为绝对路径');
  const owned=new Map<string,Owned>();
  const authorityOf=(update:RuntimeUpdateRecord):RuntimeUpdateAuthority=>{
    if(!update.ownerId)throw new Error('外部更新尚无当前所有者');
    return {updateId:update.request.updateId,ownerId:update.ownerId,token:update.token};
  };
  const currentProcess=(allocationId:string,updateId:string)=>ports.store.runtimeUpdateProcesses(updateId).find(row=>row.allocationId===allocationId)!;
  const verifyStartup=async(artifact:RuntimeArtifact,record:RuntimeUpdateProcess,signal:AbortSignal,check:Check)=>{
    check();
    if(ports.verifyStartup)await ports.verifyStartup(artifact,record,signal,check);
    else{
      const handle=owned.get(record.allocationId);if(!handle)throw new Error('健康探测缺少当前私有宿主连接');
      if(handle.child.exitCode!==null||handle.child.signalCode!==null||!handle.child.connected)throw new Error('健康探测宿主私有连接已退出');
      let health:unknown;
      if(handle.healthProtocol==='private-health-v1')health=await handle.rpc(record.authority,signal,true);
      else if(handle.healthProtocol===undefined&&ports.readLegacyStartupHealth)health=await ports.readLegacyStartupHealth(record,signal,check);
      else throw new Error('持有式宿主健康协议未知且无受校验的旧协议读取能力');
      check();if(handle.child.exitCode!==null||handle.child.signalCode!==null||!handle.child.connected)throw new Error('健康探测期间宿主私有连接已退出');
      assertHeldHostHealth(health,artifact.version,handle.activated);
    }
    check();
  };
  async function stopRecord(record:RuntimeUpdateProcess) {
    if(record.status==='exited')return true;
    const handle=owned.get(record.allocationId);
    if(handle) {
      if(!await handle.stop())return false;
      ports.store.confirmRuntimeUpdateProcessExit(currentProcess(record.allocationId,record.authority.updateId));owned.delete(record.allocationId);return true;
    }
    if(process.platform==='win32') {
      const exited=ports.confirmContainmentExit
        ? await ports.confirmContainmentExit(record)
        : await confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:record});
      if(!exited)return false;
      ports.store.confirmRuntimeUpdateProcessExit(record);return true;
    }
    if(!record.pid||!record.marker)return false;
    const exited=record.groupId
      ? await terminateProcessGroup(record.groupId,5000,record.marker)
      : await terminateProcessTree(record.pid,5000,record.marker);
    // Windows lost-root tree cleanup cannot prove orphan exit. The process
    // helper returns false on an unavailable root; do not waive that barrier.
    if(!exited)return false;
    ports.store.confirmRuntimeUpdateProcessExit(record);return true;
  }
  async function validateBytes(artifact:RuntimeArtifact,signal:AbortSignal,check:Check) {
    check();await assertRuntimeDataOutside(artifact.root,ports.dataRoot);check();
    const descriptor=await readHarnessArtifact(artifact.root,{signal,assertCurrent:check});check();
    if(JSON.stringify(descriptor)!==JSON.stringify(artifact))throw new Error('实际安装产物与外部更新身份不一致');
  }
  return {
    async prepareRollbackArtifact(update:RuntimeUpdateRecord,signal:AbortSignal,check:Check) {
      if(update.rollback) {await validateBytes(update.rollback.artifact,signal,check);return update;}
      let originalFailure:unknown;
      try {await validateBytes(update.request.before,signal,check);return update;}
      catch(error) {check();if(signal.aborted)throw error;originalFailure=error;}
      const rejected:string[]=[];
      for(const candidate of ports.store.runtimeRollbackCandidates(update.request.updateId)) {
        try {
          await validateBytes(candidate.artifact,signal,check);check();
          return ports.store.bindRuntimeRollbackTarget(authorityOf(update),candidate.sourceUpdateId,sanitizeDiagnosticText(originalFailure));
        } catch(error) {check();if(signal.aborted)throw error;rejected.push(sanitizeDiagnosticText(error));}
      }
      throw new Error(`原安装不可用且无可验证的历史回滚版本：${sanitizeDiagnosticText(originalFailure)}; ${rejected.join('; ')}`);
    },
    async validateArtifactAndCompatibility(artifact:RuntimeArtifact,update:RuntimeUpdateRecord,signal:AbortSignal,assertCurrent:Check) {
      await validateBytes(artifact,signal,assertCurrent);
      await ports.validateCompatibility(artifact,update,signal,assertCurrent);assertCurrent();
    },
    async stopOwned(update:RuntimeUpdateRecord,_authority:RuntimeUpdateAuthority,assertCurrent:Check) {
      assertCurrent();const signal=new AbortController().signal;
      if(ports.validateCompatibility.stopOwned&&!await ports.validateCompatibility.stopOwned())return false;
      assertCurrent();
      if(!await ports.confirmOldHostsStopped(update,signal,assertCurrent))return false;
      for(const record of ports.store.runtimeUpdateProcesses(update.request.updateId)) {assertCurrent();if(!await stopRecord(record))return false;}
      return true;
    },
    async freezeBusinessBaseline(update:RuntimeUpdateRecord,signal:AbortSignal,check:Check) {
      check();if(!ports.store.runtimeRepairUpdateNeedsBusinessBaseline(update.request.updateId))return;
      if(!ports.freezeBusinessBaseline)throw new Error('已验证运行修复缺少独立原业务基线读取能力');
      await ports.freezeBusinessBaseline(update,signal,check);check();ports.store.assertRuntimeBusinessBaselineReady(update);
    },
    async startHeld(artifact:RuntimeArtifact,update:RuntimeUpdateRecord,signal:AbortSignal,assertCurrent:Check) {
      assertCurrent();
      if(artifact.artifactId===update.request.candidate.artifactId)ports.store.assertRuntimeBusinessBaselineReady(update);
      await assertRuntimeDataOutside(artifact.root,ports.dataRoot);assertCurrent();
      const directory=join(ports.dataRoot,'runtime-updates','logs');await mkdir(directory,{recursive:true});assertCurrent();
      const before=ports.store.runtimeUpdateProcesses(update.request.updateId);
      const record=ports.store.reserveRuntimeUpdateProcess(authorityOf(update),artifact);
      const existing=owned.get(record.allocationId);
      if(existing){await existing.ready;assertCurrent();return;}
      if(before.some(row=>row.allocationId===record.allocationId))throw new Error('持有式启动已有记录但私有连接丢失，必须先确认旧代次退出');
      const log=(stream:string,bytes:Buffer)=>{void appendFile(join(directory,`${record.allocationId}.${stream}.log`),sanitizeDiagnosticText(bytes.toString('utf8'),64000)).catch(()=>undefined);};
      let env:NodeJS.ProcessEnv={...process.env,NODE_OPTIONS:'',NODE_PATH:'',LOOP_APP_ROOT:artifact.root,LOOP_DATA_ROOT:ports.dataRoot};
      for(const key of Object.keys(env))if(key.startsWith('LOOP_TEST')||key==='NODE_TEST_CONTEXT'||key==='LOOP_WORKSPACE_ROOT_OVERRIDE'
        || /^LOOP_(?:EXECUTION|INTERNAL|INTERVENTION|VERIFICATION_ASSISTANCE|ADMIN)_/.test(key))delete env[key];
      if(ports.electronNode)env.ELECTRON_RUN_AS_NODE='1';else {delete env.ELECTRON_RUN_AS_NODE;delete env.LOOP_DESKTOP_NODE;}
      env=withWindowsJobAdmission(env,ports.dataRoot,record.allocationId);
      const args=[join(artifact.root,'desktop-runners','host-service.cjs'),'--app-root',artifact.root,'--data-root',ports.dataRoot,
        '--external-update',update.request.updateId,'--allocation-id',record.allocationId,
        ...(ports.electronNode?['--electron-node',ports.executable]:[])];
      const child=spawn(ports.executable,args,{cwd:artifact.root,env,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
      let resolveClosed!:()=>void;const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
      let resolveReady!:()=>void;let rejectReady!:(error:Error)=>void;
      const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>undefined);
      let readySettled=false;let stopping:Promise<boolean>|undefined;let stderr='';let spawnFailedWithoutPid=false;
      let readyTimer:NodeJS.Timeout|undefined;
      const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;cleanup:()=>void;probe:boolean}>();
      const rejectAll=(error:Error)=>{for(const request of pending.values()){clearTimeout(request.timer);request.cleanup();request.reject(error);}pending.clear();};
      child.stdout!.on('data',(bytes:Buffer)=>log('stdout',bytes));child.stderr!.on('data',(bytes:Buffer)=>{stderr=(stderr+bytes.toString('utf8')).slice(-64000);log('stderr',bytes);});
      child.once('error',error=>{if(!child.pid)spawnFailedWithoutPid=true;if(!readySettled){readySettled=true;rejectReady(error);}rejectAll(error);});
      child.once('close',(code,exitSignal)=>{
        if(readyTimer)clearTimeout(readyTimer);resolveClosed();
        const error=new Error(`Held host exited code=${code} signal=${exitSignal}: ${sanitizeDiagnosticText(stderr,64000)}`);
        if(!readySettled){readySettled=true;rejectReady(error);}rejectAll(error);
      });
      child.on('message',message=>{
        if(!message||typeof message!=='object'||!('kind'in message))return;
        const value=message as Record<string,unknown>;
        if(value.kind==='update-host-ready'&&value.allocationId===record.allocationId&&value.pid===child.pid&&value.artifactId===artifact.artifactId) {
          if(!readySettled){handle.healthProtocol=value.healthProtocol;readySettled=true;if(readyTimer)clearTimeout(readyTimer);resolveReady();}
        }
        if(typeof value.requestId==='string') {
          const request=pending.get(value.requestId);if(!request)return;
          if(value.kind==='update-host-rejected') {request.reject(new Error(String(value.error)));}
          else if(!request.probe&&value.kind==='update-host-activated'&&value.allocationId===record.allocationId&&value.pid===child.pid&&value.artifactId===artifact.artifactId) {
            if(value.outcome!=='resumed')request.reject(new Error('外部更新激活未获得有效生命周期收据'));else request.resolve(undefined);
          }
          else if(request.probe&&value.kind==='update-host-health'&&value.allocationId===record.allocationId&&value.pid===child.pid&&value.artifactId===artifact.artifactId)request.resolve(value.health);
          else return;
          clearTimeout(request.timer);request.cleanup();pending.delete(value.requestId);
        }
      });
      const handle:Owned={child,ready,closed,activated:false,healthProtocol:undefined,
        stop:()=>{
          if(!stopping)stopping=(async()=>{
            if(child.exitCode===null&&child.signalCode===null&&child.connected) {
              child.send({kind:'shutdown-host'},()=>undefined);
              let timer:NodeJS.Timeout|undefined;
              try{await Promise.race([closed,new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);}finally{if(timer)clearTimeout(timer);}
            }
            const latest=currentProcess(record.allocationId,update.request.updateId);
            // Only this live spawn handle can prove no child was created.
            // A recovered reservation with no PID remains an exit barrier.
            if(!child.pid) {await closed;return spawnFailedWithoutPid&&!latest.pid;}
            if(process.platform!=='win32'&&latest.groupId) {
              if(latest.marker) {if(!await terminateProcessGroup(latest.groupId,5000,latest.marker))return false;}
              else {const members=await inspectProcessGroup(latest.groupId);if(!members||members.length)return false;}
              await closed;return true;
            }
            if(child.exitCode===null&&child.signalCode===null)return false;
            await closed;
            return ports.confirmContainmentExit
              ? !!await ports.confirmContainmentExit(latest)
              : confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:latest});
          })();return stopping;
        },
        rpc:(authority,rpcSignal,probe=false)=>new Promise<unknown>((resolve,reject)=>{
          if(rpcSignal.aborted||!child.connected){reject(new Error('持有式私有连接已经失效'));return;}
          const requestId=randomUUID();const abort=()=>{
            const request=pending.get(requestId);if(request){clearTimeout(request.timer);pending.delete(requestId);request.cleanup();reject(new Error('外部更新激活已取消'));}
          };
          const timer=setTimeout(()=>{pending.delete(requestId);rpcSignal.removeEventListener('abort',abort);reject(new Error('外部更新激活超时'));},ports.startupTimeoutMs??60000);
          pending.set(requestId,{resolve,reject,timer,probe,cleanup:()=>rpcSignal.removeEventListener('abort',abort)});rpcSignal.addEventListener('abort',abort,{once:true});
          child.send({kind:probe?'probe-update-host':'activate-update-host',requestId,authority},error=>{if(error){clearTimeout(timer);pending.delete(requestId);rpcSignal.removeEventListener('abort',abort);reject(error);}});
        }),
      };
      owned.set(record.allocationId,handle);
      const abort=()=>{void handle.stop().catch(()=>undefined);};signal.addEventListener('abort',abort,{once:true});
      readyTimer=setTimeout(()=>{if(!readySettled){readySettled=true;rejectReady(new Error('持有式宿主启动超时'));}},ports.startupTimeoutMs??60000);
      try {
        if(!child.pid){await closed;await ready;throw new Error('持有式宿主未分配 PID');}
        if(!await attachWindowsJobContainment({dataRoot:ports.dataRoot,allocationId:record.allocationId,pid:child.pid}))
          throw new Error('持有式宿主无法进入 Windows Job 容器');
        ports.store.bindRuntimeUpdateProcess(record,child.pid,undefined,process.platform!=='win32'?child.pid:undefined);
        const identity=await waitForProcessIdentity(child.pid,{timeoutMs:5000});
        if(identity)ports.store.bindRuntimeUpdateProcess(record,child.pid,identity.startMarker,process.platform!=='win32'?child.pid:undefined);
        await ready;assertCurrent();if(!identity)throw new Error('持有式宿主缺少实际进程身份');
        await verifyStartup(artifact,currentProcess(record.allocationId,update.request.updateId),signal,assertCurrent);assertCurrent();
        ports.store.advanceRuntimeUpdateProcess(authorityOf(update),record.allocationId,'bound','ready');
      } catch(error) {await handle.stop().catch(()=>false);throw error;}
      finally{if(readyTimer)clearTimeout(readyTimer);signal.removeEventListener('abort',abort);}
    },
    async activate(artifact:RuntimeArtifact,update:RuntimeUpdateRecord,signal:AbortSignal,assertCurrent:Check) {
      assertCurrent();const record=ports.store.runtimeUpdateProcesses(update.request.updateId).find(row=>row.status!=='exited'&&row.artifact.artifactId===artifact.artifactId);
      const handle=record&&owned.get(record.allocationId);if(!record||!handle)throw new Error('待激活宿主没有当前私有连接');
      await handle.rpc(authorityOf(update),signal);assertCurrent();
      if(record.status!=='activated')ports.store.advanceRuntimeUpdateProcess(authorityOf(update),record.allocationId,'ready','activated');handle.activated=true;
    },
    async observeStartup(artifact:RuntimeArtifact,update:RuntimeUpdateRecord,signal:AbortSignal,assertCurrent:Check):Promise<'healthy'|'failed'> {
      assertCurrent();const record=ports.store.runtimeUpdateProcesses(update.request.updateId).find(row=>row.status==='activated'&&row.artifact.artifactId===artifact.artifactId);
      const handle=record&&owned.get(record.allocationId);if(!record||!handle||handle.child.exitCode!==null||handle.child.signalCode!==null)return 'failed';
      await verifyStartup(artifact,record,signal,assertCurrent);assertCurrent();return 'healthy';
    },
    async cancelOwned(authority:RuntimeUpdateAuthority) {
      // Attempt every cleanup even if another refuses or throws. Fulfilled
      // cancellation is physical exit proof for the external lease barrier.
      const records=ports.store.runtimeUpdateProcesses(authority.updateId).filter(record=>
        record.authority.ownerId===authority.ownerId&&record.authority.token===authority.token);
      const results=await Promise.allSettled([
        Promise.resolve().then(()=>ports.validateCompatibility.stopOwned?ports.validateCompatibility.stopOwned(authority):true),
        Promise.resolve().then(()=>ports.readLegacyStartupHealth?.stopOwned?ports.readLegacyStartupHealth.stopOwned():true),
        ...records.map(record=>stopRecord(record)),
      ]);
      if(results.some(result=>result.status==='rejected'||result.value!==true)) {
        throw new AggregateError(results.filter(result=>result.status==='rejected').map(result=>result.reason),
          '外部更新受管进程退出未确认，保留所有权屏障');
      }
    },
  };
}
