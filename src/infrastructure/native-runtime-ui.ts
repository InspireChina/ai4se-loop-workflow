import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {appendFile,mkdir} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import type {RuntimeArtifact,RuntimeHostAuthority,RuntimeUiProcess} from '../domain/runtime-update';
import type {AdminManagementStore} from './admin-management-store';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {inspectProcessGroup,terminateProcessGroup,waitForProcessIdentity} from './process-tree';
import {sanitizeDiagnosticText} from './diagnostic-text';
import {uiLifecycleRequestSchema,type UiLifecycleRequest} from '../domain/ui-lifecycle-protocol';
import {attachWindowsJobContainment,confirmWindowsJobContainmentExit,withWindowsJobAdmission} from './windows-job-containment';

const runFile=promisify(execFile);
async function ownsListener(pid:number,port:number){
  try{
    const command=process.platform==='win32'?'powershell.exe':process.platform==='darwin'?'/usr/sbin/lsof':'lsof';
    const args=process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',
      `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess`]
      :['-nP','-a','-p',String(pid),`-iTCP:${port}`,'-sTCP:LISTEN','-t'];
    const {stdout}=await runFile(command,args,{timeout:1500,maxBuffer:4096,windowsHide:true});
    return stdout.trim().split(/\s+/).some(value=>value===String(pid));
  }catch{return false;} // Missing/unknown OS evidence is not ownership proof.
}

/** UI ownership is recorded before spawn in the independent database. A child
 * exit alone never releases the allocation: the actual container must be empty.
 * This component opens no business database and starts no business execution. */
export function createNativeRuntimeUi(ports:{store:AdminManagementStore;dataRoot:string;toolRoot:string;executable:string;electronNode?:boolean;
  startupTimeoutMs?:number;onError?:(error:unknown)=>void;
  confirmContainmentExit?:(record:RuntimeUiProcess)=>Promise<boolean>;
  onLifecycleRequest?:(request:UiLifecycleRequest)=>Promise<unknown>;
  onUnavailable?:(record:RuntimeUiProcess,error:Error)=>void;
}){
  if(!isAbsolute(ports.dataRoot)||!isAbsolute(ports.toolRoot)||!isAbsolute(ports.executable))throw new Error('界面服务路径必须是实际绝对路径');
  const handles=new Map<string,{child:ChildProcess;closed:Promise<void>;record:RuntimeUiProcess;url:string;noSpawn:boolean}>();
  const stopping=new Map<string,Promise<boolean>>();let starting:Promise<{url:string}>|undefined;
  const report=(error:unknown)=>{try{ports.onError?.(error);}catch{/* Logging cannot block termination. */}};
  const current=(record:RuntimeUiProcess)=>ports.store.runtimeUiProcesses().find(row=>row.allocationId===record.allocationId)!;
  function stopRecord(record:RuntimeUiProcess):Promise<boolean>{
    if(record.status==='exited')return Promise.resolve(true);
    const pending=stopping.get(record.allocationId);if(pending)return pending;
    const work=(async()=>{
      const handle=handles.get(record.allocationId);let captured=handle?.record??record;
      try{captured=current(record)??captured;}catch(error){report(error);}
      // Even first attachment/storage failure retains the actual ChildProcess
      // identity. Only inspect a still-live captured root, never a reused PID.
      if(handle?.child.pid&&!captured.pid)captured={...captured,pid:handle.child.pid,groupId:process.platform!=='win32'?handle.child.pid:null};
      if(handle&&captured.pid&&!captured.marker&&handle.child.exitCode===null&&handle.child.signalCode===null){
        const identity=await waitForProcessIdentity(captured.pid,{timeoutMs:1000}).catch(error=>{report(error);return null;});
        if(identity&&handle.child.exitCode===null&&handle.child.signalCode===null){
          captured={...captured,marker:identity.startMarker};handle.record=captured;
          try{ports.store.bindRuntimeUiProcess(record,captured.pid!,identity.startMarker,captured.groupId??undefined);}catch(error){report(error);}
        }
      }
      let exited=false;
      if(!captured.pid)exited=!!handle?.noSpawn;
      else if(process.platform==='win32')exited=ports.confirmContainmentExit
        ? !!await ports.confirmContainmentExit(captured)
        : await confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:captured});
      else if(captured.groupId)exited=captured.marker?await terminateProcessGroup(captured.groupId,5000,captured.marker)
        :await inspectProcessGroup(captured.groupId).then(members=>!!members&&members.length===0);
      if(!exited)return false;
      if(handle)await handle.closed;
      // Storage failure keeps the barrier even after physical termination.
      ports.store.confirmRuntimeUiProcessExit(current(record));handles.delete(record.allocationId);return true;
    })().finally(()=>stopping.delete(record.allocationId));stopping.set(record.allocationId,work);return work;
  }
  async function drain(records:RuntimeUiProcess[],check:()=>void){
    check();const results=await Promise.allSettled(records.map(record=>Promise.resolve().then(()=>{check();return stopRecord(record);})));check();
    for(const result of results)if(result.status==='rejected')report(result.reason);
    return results.every(result=>result.status==='fulfilled'&&result.value===true);
  }
  return {
    drainAll:(check:()=>void=()=>undefined)=>drain(ports.store.runtimeUiProcesses().filter(row=>row.status!=='exited'),check),
    drainPrevious:(authority:RuntimeHostAuthority,check:()=>void)=>drain(ports.store.runtimeUiProcesses().filter(row=>row.status!=='exited'
      &&(row.authority.ownerId!==authority.ownerId||row.authority.token!==authority.token)),check),
    cancelOwned:(authority:RuntimeHostAuthority)=>drain(ports.store.runtimeUiProcesses().filter(row=>row.status!=='exited'
      &&row.authority.ownerId===authority.ownerId&&row.authority.token===authority.token),()=>undefined),
    assertStopped(){if(ports.store.runtimeUiProcesses().some(row=>row.status!=='exited'))throw new Error('界面服务进程屏障仍未退出');},
    start(artifact:RuntimeArtifact,authority:RuntimeHostAuthority,port:number,signal:AbortSignal,check:()=>void){
      if(starting)return starting;
      if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('界面服务端口无效');
      const guard=()=>{check();signal.throwIfAborted();ports.store.assertRuntimeHost(authority);
        if(ports.store.control().management_mode!=='normal'||ports.store.activeRuntimeUpdate()
          ||JSON.stringify(ports.store.runtimeInstallation()?.artifact)!==JSON.stringify(artifact))throw new Error('界面服务来源或更新门禁已变化');};
      starting=(async()=>{
        guard();if(JSON.stringify(await readHarnessArtifact(artifact.root,{signal,assertCurrent:guard}))!==JSON.stringify(artifact))throw new Error('界面服务实际产物不匹配');guard();
        const tools=ports.store.runtimeHostArtifact(authority);
        if(!tools||tools.root!==ports.toolRoot||JSON.stringify(await readHarnessArtifact(ports.toolRoot,{signal,assertCurrent:guard}))!==JSON.stringify(tools))throw new Error('界面启动 helper 不属于当前稳定 root');guard();
        const prior=ports.store.runtimeUiProcesses().find(row=>row.status!=='exited');const handle=prior&&handles.get(prior.allocationId);
        if(prior?.status==='ready'&&handle&&prior.authority.ownerId===authority.ownerId&&prior.authority.token===authority.token
          &&JSON.stringify(prior.artifact)===JSON.stringify(artifact)&&handle.child.exitCode===null&&handle.child.signalCode===null)return {url:handle.url};
        if(!await drain(ports.store.runtimeUiProcesses().filter(row=>row.status!=='exited'),guard))throw new Error('旧界面服务退出未确认');
        const logs=join(ports.dataRoot,'runtime-ui','logs');await mkdir(logs,{recursive:true,mode:0o700});guard();
        const record=ports.store.reserveRuntimeUiProcess(authority,artifact);const url=`http://127.0.0.1:${port}`;
        let env:NodeJS.ProcessEnv={...process.env};
        for(const key of Object.keys(env))if(/^LOOP_/i.test(key)||key==='NODE_TEST_CONTEXT')delete env[key];
        Object.assign(env,{NODE_OPTIONS:'',NODE_PATH:'',NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),LOOP_DESKTOP:'1',
          LOOP_APP_ROOT:artifact.root,LOOP_DATA_ROOT:ports.dataRoot,LOOP_GLOBAL_DB_PATH:join(ports.dataRoot,'loop-ui.db')});
        if(ports.electronNode){env.ELECTRON_RUN_AS_NODE='1';env.LOOP_DESKTOP_NODE=ports.executable;}else delete env.ELECTRON_RUN_AS_NODE;
        env=withWindowsJobAdmission(env,ports.dataRoot,record.allocationId);
        const child=spawn(ports.executable,[join(ports.toolRoot,'desktop-runners','ui-server.cjs'),'--app-root',artifact.root,'--data-root',ports.dataRoot,'--ui-allocation',record.allocationId],
          {cwd:artifact.root,env,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
        let resolveClosed!:()=>void;const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
        const owned={child,closed,record:{...record,pid:child.pid??null,groupId:process.platform!=='win32'?child.pid??null:null},url,noSpawn:false};
        handles.set(record.allocationId,owned);let spawnError:Error|undefined;let stderr='';
        child.once('error',error=>{spawnError=error;owned.noSpawn=!child.pid;});child.once('close',(code,exitSignal)=>{
          resolveClosed();
          try{const latest=current(record);if(latest?.status==='ready'&&!stopping.has(record.allocationId))
            ports.onUnavailable?.(latest,new Error(`界面服务退出 code=${code} signal=${exitSignal}: ${sanitizeDiagnosticText(stderr)}`));}
          catch(error){report(error);}
        });
        const log=(stream:string,chunk:Buffer)=>{void appendFile(join(logs,`${record.allocationId}.${stream}.log`),sanitizeDiagnosticText(chunk.toString()),{mode:0o600}).catch(report);};
        child.stdout!.on('data',chunk=>log('stdout',chunk));child.stderr!.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-64000);log('stderr',chunk);});
        let authorized=false;let requests=0;
        child.on('message',message=>{
          if(message&&typeof message==='object'&&'kind'in message&&message.kind==='ui-server-authorized'
            &&'allocationId'in message&&message.allocationId===record.allocationId&&'pid'in message&&message.pid===child.pid
            &&'artifactId'in message&&message.artifactId===artifact.artifactId&&'protocolVersion'in message&&message.protocolVersion===1){authorized=true;return;}
          const parsed=uiLifecycleRequestSchema.safeParse(message);if(!parsed.success||parsed.data.allocationId!==record.allocationId)return;
          const request=parsed.data;
          const respond=(ok:boolean,value?:unknown)=>{try{if(child.connected)child.send({kind:'ui-lifecycle-response',allocationId:record.allocationId,requestId:request.requestId,ok,value},()=>undefined);}catch(error){report(error);}};
          if(requests>=32){respond(false);return;}requests++;
          void Promise.resolve().then(async()=>{guard();if(!authorized||current(record)?.status!=='ready'||!ports.onLifecycleRequest)throw new Error('界面生命周期通道尚未授权');
            const result=await ports.onLifecycleRequest(request);guard();respond(true,result);
          }).catch(error=>{report(error);respond(false);}).finally(()=>{requests--;});
        });
        const abort=()=>{void stopRecord(record).catch(report);};signal.addEventListener('abort',abort,{once:true});
        try{
          if(!child.pid){await closed;throw spawnError??new Error('界面服务未分配 PID');}
          if(!await attachWindowsJobContainment({dataRoot:ports.dataRoot,allocationId:record.allocationId,pid:child.pid}))
            throw new Error('界面服务无法进入 Windows Job 容器');
          ports.store.bindRuntimeUiProcess(record,child.pid,undefined,owned.record.groupId??undefined);
          const identity=await waitForProcessIdentity(child.pid,{timeoutMs:5000});guard();
          if(!identity)throw new Error('界面服务缺少真实进程身份');
          owned.record={...owned.record,marker:identity.startMarker};ports.store.bindRuntimeUiProcess(record,child.pid,identity.startMarker,owned.record.groupId??undefined);
          const deadline=Date.now()+(ports.startupTimeoutMs??30000);
          while(true){
            guard();if(child.exitCode!==null||child.signalCode!==null)throw new Error(`界面服务退出 code=${child.exitCode} signal=${child.signalCode}: ${sanitizeDiagnosticText(stderr)}`);
            try{if(authorized&&await ownsListener(child.pid,port)){
              guard();const response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(1000)])});await response.body?.cancel();guard();
              if(response.status<500&&await ownsListener(child.pid,port)){guard();break;}
            }}
            catch(error){guard();if(spawnError)throw spawnError;}
            if(Date.now()>=deadline)throw new Error('界面服务启动确认超时');
            await new Promise(resolve=>setTimeout(resolve,150));
          }
          guard();ports.store.readyRuntimeUiProcess(current(record));return {url};
        }catch(error){await stopRecord(record).catch(report);throw error;}
        finally{signal.removeEventListener('abort',abort);}
      })().finally(()=>{starting=undefined;});return starting;
    },
  };
}
