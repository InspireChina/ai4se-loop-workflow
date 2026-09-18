import type {AdminManagementStore} from './admin-management-store';
import {inspectProcessGroup,terminateProcessGroup,terminateProcessTree} from './process-tree';
import {dirname} from 'node:path';
import {confirmWindowsJobContainmentExit,inspectProcessWindowsJobMembership,type WindowsJobMembership} from './windows-job-containment';

const windowsCallerMembership=new Map<string,{membership:'member'|'unknown';expiresAt:number}>();

/** No business DB imports, migrations or writes. POSIX callers use their
 * captured process group. Standard Windows admission is fenced by the current
 * host/business generations; Job membership is reserved for explicit strict
 * containment. */
export async function assertRuntimeCliCaller(store:AdminManagementStore,hostAllocationId:string,options?:{
  platform?:NodeJS.Platform;supervisionToken?:number;safetyMode?:'standard'|'strict';
  inspectMembership?:()=>Promise<WindowsJobMembership>;onDegraded?:(message:string)=>void;
}) {
  const host=store.runtimeHostProcesses().find(row=>row.allocationId===hostAllocationId);
  if(!host?.pid||!host.marker)throw new Error('无法确认业务调用进程属于外部宿主容器');
  if((options?.platform??process.platform)==='win32'){
    // Routine writes are fenced by the current root generation and business
    // lease. Standard mode intentionally skips synchronous OS Job inspection:
    // a transient PowerShell/WMI failure must not turn a healthy single
    // instance into an outage.
    store.assertRuntimeHost(host.authority);
    const supervisionToken=options?.supervisionToken??Number(process.env.LOOP_SUPERVISION_TOKEN||0);
    if(host.status!=='ready'||!host.businessSupervisionToken||host.businessSupervisionToken!==supervisionToken)
      throw new Error('业务调用进程不属于当前有效业务监督代次');
    if((options?.safetyMode??process.env.LOOP_RUNTIME_SAFETY)==='standard')return;
    const key=`${host.allocationId}:${process.pid}`,cached=options?.inspectMembership?undefined:windowsCallerMembership.get(key);
    let membership:WindowsJobMembership;
    if(cached&&cached.expiresAt>Date.now())membership=cached.membership;
    else{
      membership=await (options?.inspectMembership?.()??inspectProcessWindowsJobMembership({
        dataRoot:dirname(store.filename),allocationId:host.allocationId,pid:process.pid,timeoutMs:2500,
      }));
      if(!options?.inspectMembership&&membership!=='not-member')windowsCallerMembership.set(key,{membership,
        expiresAt:membership==='member'?Number.POSITIVE_INFINITY:Date.now()+60_000});
    }
    if(membership==='not-member')throw new Error('业务调用进程不属于当前 Windows Job 宿主容器');
    if(membership==='unknown')(options?.onDegraded??(message=>console.warn(`[runtime-cli] ${message}`)))
      ('Windows Job 归属暂时无法观察，已依据当前单实例宿主与业务监督代次放行');
    return;
  }
  if(!host.groupId)throw new Error('无法确认业务调用进程属于外部宿主容器');
  const members=await inspectProcessGroup(host.groupId);
  if(!members?.some(member=>member.pid===host.pid&&member.startMarker===host.marker)
    ||!members.some(member=>member.pid===process.pid))throw new Error('业务调用进程不属于当前实际宿主进程组');
}

export async function drainRuntimeCliRegistry(store:AdminManagementStore,hostAllocationId:string,
  terminate:typeof terminateProcessGroup=terminateProcessGroup,options:{strictContainment?:boolean}={}) {
  const certified=store.beginRuntimeCliDrain(hostAllocationId);
  const records=store.runtimeCliProcesses(hostAllocationId).filter(row=>row.status!=='exited');
  const results=await Promise.allSettled(records.map(async record=>{
    store.finishRuntimeCli(record.allocationId,false);
    if(!record.pid){if(options.strictContainment===false){store.finishRuntimeCli(record.allocationId,true);return true;}return false;}
    if(process.platform==='win32'){
      const exited=options.strictContainment===false
        ?await terminateProcessTree(record.pid,10000)
        :!!record.marker&&await confirmWindowsJobContainmentExit({dataRoot:dirname(store.filename),process:record,timeoutMs:10000});
      store.finishRuntimeCli(record.allocationId,exited);return exited;
    }
    if(!record.marker)return false;
    if(!record.groupId)return false;
    const exited=await terminate(record.groupId,10000,record.marker);
    store.finishRuntimeCli(record.allocationId,exited);return exited;
  }));
  return certified&&results.every(result=>result.status==='fulfilled'&&result.value===true)
    &&store.runtimeCliProcesses(hostAllocationId).every(row=>row.status==='exited');
}
