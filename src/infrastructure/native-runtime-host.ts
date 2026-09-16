import {spawn,type ChildProcess} from 'node:child_process';
import {appendFile,mkdir} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import type {RuntimeArtifact,RuntimeHostAuthority,RuntimeHostProcess} from '../domain/runtime-update';
import type {AdminManagementStore} from './admin-management-store';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {assertRuntimeDataOutside} from './runtime-paths';
import {inspectProcessGroup,terminateProcessGroup,waitForProcessIdentity} from './process-tree';
import {sanitizeDiagnosticText} from './diagnostic-text';
import {drainRuntimeCliRegistry} from './runtime-cli-registry';
import {StringDecoder} from 'node:string_decoder';
import {attachWindowsJobContainment,confirmWindowsJobContainmentExit,withWindowsJobAdmission} from './windows-job-containment';

type Check=()=>void;
type Owned={child:ChildProcess;closed:Promise<void>;ready:Promise<void>;noPidFailure:()=>boolean};

/** Native ordinary-host ports for the stable external root. Detached Agent
 * groups need their own drain proof: root/group close alone is insufficient.
 * Required ports intentionally have no always-success production defaults. */
export function createNativeRuntimeHost(ports:{
  store:AdminManagementStore;dataRoot:string;executable:string;electronNode?:boolean;startupTimeoutMs?:number;
  drainUpdates:(check:Check)=>Promise<boolean>;
  confirmDescendantsExited:(record:RuntimeHostProcess)=>Promise<boolean>;
  assertUntrackedOrdinaryHostsExited?:(signal:AbortSignal,check:Check)=>Promise<void>;
  confirmContainmentExit?:(record:RuntimeHostProcess)=>Promise<boolean>;
  onError?:(error:unknown)=>void;
}) {
  if(!isAbsolute(ports.dataRoot)||!isAbsolute(ports.executable))throw new Error('外部普通宿主路径必须为绝对路径');
  const owned=new Map<string,Owned>();const stopping=new Map<string,Promise<boolean>>();
  const report=(error:unknown)=>{try{ports.onError?.(error);}catch{/* diagnostics cannot suppress kills */}};
  const current=(id:string)=>ports.store.runtimeHostProcesses().find(row=>row.allocationId===id)!;
  async function physicalExit(record:RuntimeHostProcess) {
    const handle=owned.get(record.allocationId);
    if(handle?.child.connected&&handle.child.exitCode===null&&handle.child.signalCode===null) {
      handle.child.send({kind:'shutdown-host'},()=>undefined);
      let timer:NodeJS.Timeout|undefined;
      try {await Promise.race([handle.closed,new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);}
      finally {if(timer)clearTimeout(timer);}
    }
    let latest=record;
    try{const found=current(record.allocationId);if(!found)throw new Error('捕获宿主分配记录缺失');latest=found;}
    catch(error){report(error);} // storage failure cannot suppress the captured physical kill
    if(!latest.pid)return !!handle?.noPidFailure();
    if(process.platform==='win32')return ports.confirmContainmentExit
      ? !!await ports.confirmContainmentExit(latest)
      : confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:latest});
    if(!latest.groupId)return false;
    const exited=latest.marker?await terminateProcessGroup(latest.groupId,5000,latest.marker):
      await inspectProcessGroup(latest.groupId).then(members=>!!members&&members.length===0);
    if(exited&&handle)await handle.closed;
    return exited;
  }
  function stopRecord(record:RuntimeHostProcess):Promise<boolean> {
    if(record.status==='exited')return Promise.resolve(true);
    const existing=stopping.get(record.allocationId);if(existing)return existing;
    const work=(async()=>{
      // Close admission durably before killing/scanning: a late reservation
      // cannot slip between an empty registry read and root exit confirmation.
      let certified=false;let admissionClosed=false;
      try{certified=ports.store.beginRuntimeCliDrain(record.allocationId);admissionClosed=true;}
      catch(error){report(error);}
      const knownNoSpawn=!!owned.get(record.allocationId)?.noPidFailure()&&!record.pid;
      const results=await Promise.allSettled([
        physicalExit(record),Promise.resolve().then(()=>knownNoSpawn?true:ports.confirmDescendantsExited(record)),
        Promise.resolve().then(()=>certified?drainRuntimeCliRegistry(ports.store,record.allocationId):true),
      ]);
      for(const result of results)if(result.status==='rejected')report(result.reason);
      if(!admissionClosed||results.some(result=>result.status==='rejected'||result.value!==true))return false;
      ports.store.confirmRuntimeHostProcessExit(current(record.allocationId));owned.delete(record.allocationId);return true;
    })().finally(()=>stopping.delete(record.allocationId));stopping.set(record.allocationId,work);return work;
  }
  async function validateInstalled(artifact:RuntimeArtifact,signal:AbortSignal,check:Check) {
    check();await assertRuntimeDataOutside(artifact.root,ports.dataRoot);check();
    if(JSON.stringify(await readHarnessArtifact(artifact.root,{signal,assertCurrent:check}))!==JSON.stringify(artifact))throw new Error('普通宿主实际产物与安装选择不匹配');
  }
  async function drainAll(check:Check) {
    check();const results=await Promise.allSettled(ports.store.runtimeHostProcesses().filter(row=>row.status!=='exited').map(stopRecord));
    check();return results.every(result=>result.status==='fulfilled'&&result.value===true);
  }
  const drainNormal=(_authority:RuntimeHostAuthority,check:Check)=>drainAll(check);
  return {
    validateInstalled,drainNormal,drainAll,
    async ensureSelected(artifact:RuntimeArtifact,authority:RuntimeHostAuthority,signal:AbortSignal,check:Check) {
      const assertCurrent=()=>{
        check();ports.store.assertRuntimeHost(authority);
        if(signal.aborted||ports.store.control().management_mode!=='normal'||ports.store.activeRuntimeUpdate()||JSON.stringify(ports.store.runtimeInstallation()?.artifact)!==JSON.stringify(artifact))throw new Error('普通宿主安装选择或代次已经变化');
      };
      await validateInstalled(artifact,signal,assertCurrent);assertCurrent();
      const prior=ports.store.runtimeHostProcesses().find(row=>row.status!=='exited');
      const handle=prior&&owned.get(prior.allocationId);
      if(prior&&handle&&prior.authority.ownerId===authority.ownerId&&prior.authority.token===authority.token
        &&JSON.stringify(prior.artifact)===JSON.stringify(artifact)&&handle.child.connected&&handle.child.exitCode===null&&handle.child.signalCode===null) {
        await handle.ready;assertCurrent();return;
      }
      if(!await drainNormal(authority,assertCurrent)||!await ports.drainUpdates(assertCurrent))throw new Error('旧宿主或更新进程退出未确认，禁止普通启动');
      await ports.assertUntrackedOrdinaryHostsExited?.(signal,assertCurrent);assertCurrent();
      const directory=join(ports.dataRoot,'runtime-hosts','logs');await mkdir(directory,{recursive:true,mode:0o700});assertCurrent();
      const record=ports.store.reserveRuntimeHostProcess(authority,artifact);
      let env:NodeJS.ProcessEnv={...process.env,NODE_OPTIONS:'',NODE_PATH:'',LOOP_APP_ROOT:artifact.root,LOOP_DATA_ROOT:ports.dataRoot,LOOP_GLOBAL_DB_PATH:join(ports.dataRoot,'loop-ui.db')};
      for(const key of Object.keys(env))if(key.startsWith('LOOP_TEST')||key==='NODE_TEST_CONTEXT'||key==='LOOP_WORKSPACE_ROOT_OVERRIDE'
        ||/^LOOP_(?:EXECUTION|INTERNAL|INTERVENTION|VERIFICATION_ASSISTANCE|ADMIN)_/.test(key))delete env[key];
      if(ports.electronNode)env.ELECTRON_RUN_AS_NODE='1';else {delete env.ELECTRON_RUN_AS_NODE;delete env.LOOP_DESKTOP_NODE;}
      env=withWindowsJobAdmission(env,ports.dataRoot,record.allocationId);
      const child=spawn(ports.executable,[join(artifact.root,'desktop-runners','host-service.cjs'),'--app-root',artifact.root,'--data-root',ports.dataRoot,
        '--host-allocation',record.allocationId,...(ports.electronNode?['--electron-node',ports.executable]:[])],
        {cwd:artifact.root,env,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
      let noPidFailure=false;let stderr='';let stdout='';let stdoutLine='';let fatal='';
      let businessSupervisionToken:number|undefined;
      const stdoutDecoder=new StringDecoder('utf8');
      const captureStdout=(text:string)=>{
        stdout=(stdout+text).slice(-64000);
        // Parse complete lines before bounding the partial-line buffer. A
        // coalesced fatal + noisy shutdown chunk must not erase its first line.
        const lines=text.split('\n');
        for(let index=0;index<lines.length;index++){
          stdoutLine=(stdoutLine+lines[index]).slice(-64000);
          if(index===lines.length-1)break;
          const line=stdoutLine;stdoutLine='';
          try{
            const event=JSON.parse(line);
            if(event?.kind==='host-fatal'&&event.pid===child.pid&&typeof event.error==='string')
              fatal=sanitizeDiagnosticText(event.error,64000);
          }catch{/* Ordinary stdout is diagnostic text, not necessarily JSON. */}
        }
      };
      let resolveClosed!:()=>void;const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
      let resolveReady!:()=>void;let rejectReady!:(error:Error)=>void;const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});void ready.catch(()=>undefined);
      const readyTimer=setTimeout(()=>rejectReady(new Error('普通宿主启动确认超时')),ports.startupTimeoutMs??60000);
      const log=(stream:string,bytes:Buffer)=>{void appendFile(join(directory,`${record.allocationId}.${stream}.log`),sanitizeDiagnosticText(bytes.toString('utf8'),64000),{mode:0o600}).catch(report);};
      child.stdout!.on('data',bytes=>{captureStdout(stdoutDecoder.write(bytes));log('stdout',bytes);});child.stderr!.on('data',bytes=>{stderr=(stderr+bytes.toString('utf8')).slice(-64000);log('stderr',bytes);});
      child.once('error',error=>{noPidFailure=!child.pid;rejectReady(error);});
      child.once('close',(code,exitSignal)=>{
        captureStdout(stdoutDecoder.end());clearTimeout(readyTimer);resolveClosed();
        const detail=fatal||sanitizeDiagnosticText(stderr||stdout,64000);
        rejectReady(new Error(`普通宿主退出 code=${code} signal=${exitSignal}: ${detail}`));
      });
      child.on('message',message=>{
        if(message&&typeof message==='object'&&'kind'in message&&message.kind==='normal-host-ready'
          &&'allocationId'in message&&message.allocationId===record.allocationId&&'pid'in message&&message.pid===child.pid
          &&'artifactId'in message&&message.artifactId===artifact.artifactId){
          if('businessSupervisionToken'in message&&Number.isSafeInteger(message.businessSupervisionToken)&&Number(message.businessSupervisionToken)>0)
            businessSupervisionToken=Number(message.businessSupervisionToken);
          clearTimeout(readyTimer);resolveReady();}
      });
      owned.set(record.allocationId,{child,closed,ready,noPidFailure:()=>noPidFailure});
      const abort=()=>{rejectReady(new Error('普通宿主启动已取消'));void stopRecord(current(record.allocationId)).catch(report);};signal.addEventListener('abort',abort,{once:true});
      try {
        if(!child.pid){
          // A failed spawn emits its concrete OS error before close. Keep
          // that readiness rejection (code/path/syscall) rather than replacing
          // it with a generic missing-PID diagnosis. Still await actual close
          // before the positively empty allocation may be settled.
          await closed;await ready;throw new Error('普通宿主未分配 PID');
        }
        if(!await attachWindowsJobContainment({dataRoot:ports.dataRoot,allocationId:record.allocationId,pid:child.pid}))
          throw new Error('普通宿主无法进入 Windows Job 容器');
        ports.store.bindRuntimeHostProcess(record,child.pid,undefined,process.platform!=='win32'?child.pid:undefined);
        const identity=await waitForProcessIdentity(child.pid,{timeoutMs:5000});
        if(identity)ports.store.bindRuntimeHostProcess(record,child.pid,identity.startMarker,process.platform!=='win32'?child.pid:undefined);
        await ready;assertCurrent();if(!identity)throw new Error('普通宿主缺少真实进程身份');
        ports.store.readyRuntimeHostProcess(authority,record.allocationId,businessSupervisionToken);
      }catch(error){await stopRecord(current(record.allocationId)).catch(report);throw error;}
      finally{clearTimeout(readyTimer);signal.removeEventListener('abort',abort);}
    },
    async cancelOwned(authority:RuntimeHostAuthority) {
      const records=ports.store.runtimeHostProcesses().filter(row=>row.status!=='exited'&&row.authority.ownerId===authority.ownerId&&row.authority.token===authority.token);
      const results=await Promise.allSettled(records.map(stopRecord));
      for(const result of results)if(result.status==='rejected')report(result.reason);
      return results.every(result=>result.status==='fulfilled'&&result.value===true);
    },
  };
}
