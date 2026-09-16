import type {AdminManagementStore} from './admin-management-store';
import {inspectProcessGroup,terminateProcessGroup} from './process-tree';
import {dirname} from 'node:path';
import {confirmWindowsJobContainmentExit,isProcessInWindowsJob} from './windows-job-containment';

/** No business DB imports, migrations or writes. Captured group identities are
 * sufficient for registered POSIX groups, not escaping descendants or Windows
 * Job containers. Those still require native containment evidence. */
export async function assertRuntimeCliCaller(store:AdminManagementStore,hostAllocationId:string) {
  const host=store.runtimeHostProcesses().find(row=>row.allocationId===hostAllocationId);
  if(!host?.pid||!host.marker)throw new Error('无法确认业务调用进程属于外部宿主容器');
  if(process.platform==='win32'){
    if(!await isProcessInWindowsJob({dataRoot:dirname(store.filename),allocationId:host.allocationId,pid:process.pid}))
      throw new Error('业务调用进程不属于当前 Windows Job 宿主容器');
    return;
  }
  if(!host.groupId)throw new Error('无法确认业务调用进程属于外部宿主容器');
  const members=await inspectProcessGroup(host.groupId);
  if(!members?.some(member=>member.pid===host.pid&&member.startMarker===host.marker)
    ||!members.some(member=>member.pid===process.pid))throw new Error('业务调用进程不属于当前实际宿主进程组');
}

export async function drainRuntimeCliRegistry(store:AdminManagementStore,hostAllocationId:string,
  terminate:typeof terminateProcessGroup=terminateProcessGroup) {
  const certified=store.beginRuntimeCliDrain(hostAllocationId);
  const records=store.runtimeCliProcesses(hostAllocationId).filter(row=>row.status!=='exited');
  const results=await Promise.allSettled(records.map(async record=>{
    store.finishRuntimeCli(record.allocationId,false);
    if(!record.pid||!record.marker)return false;
    if(process.platform==='win32'){
      const exited=await confirmWindowsJobContainmentExit({dataRoot:dirname(store.filename),process:record,timeoutMs:10000});
      store.finishRuntimeCli(record.allocationId,exited);return exited;
    }
    if(!record.groupId)return false;
    const exited=await terminate(record.groupId,10000,record.marker);
    store.finishRuntimeCli(record.allocationId,exited);return exited;
  }));
  return certified&&results.every(result=>result.status==='fulfilled'&&result.value===true)
    &&store.runtimeCliProcesses(hostAllocationId).every(row=>row.status==='exited');
}
