import type {AdminAuthority} from '../domain/repair-case';
import type {RuntimeHostProcess,RuntimeUpdateProcess} from '../domain/runtime-update';
import type {RuntimeCliProcess} from '../domain/runtime-cli';
import type {AdminManagementStore} from './admin-management-store';
import {assertRuntimeVerificationInput} from './runtime-verification-input';
import {inspectProcessGroup} from './process-tree';
import {confirmWindowsJobContainmentExit,waitForProcessWindowsJobMembership} from './windows-job-containment';

/** Root-owned read-only physical proof. No business DB imports or workflow
 * completion; a ready flag cannot substitute for actual process containment. */
export async function confirmRuntimeRepairHandoff(ports:{
  store:AdminManagementStore;authority:AdminAuthority;caseId:string;dataRoot:string;signal?:AbortSignal;
  assertContainment?:(host:RuntimeHostProcess,predecessors:(RuntimeHostProcess|RuntimeUpdateProcess)[],clis:RuntimeCliProcess[],check:()=>void)=>Promise<void>;
}) {
  const target=ports.store.runtimeRepairHandoffTarget(ports.authority,ports.caseId);
  if(!target)return null;
  const check=()=>{
    ports.signal?.throwIfAborted();
    const current=ports.store.runtimeRepairHandoffTarget(ports.authority,ports.caseId);
    if(!current||JSON.stringify(current.receipt)!==JSON.stringify(target.receipt))throw new Error('运行修复物理交还来源已变化');
  };
  check();
  if(target.host.parentPid!==process.pid||target.host.pid===process.pid)throw new Error('运行修复交还只能由实际父 Root 验证');
  await assertRuntimeVerificationInput(target.input,{...ports,assertCurrent:check});check();
  if(process.platform==='win32') {
    if(ports.assertContainment)await ports.assertContainment(target.host,target.predecessors,target.previousClis,check);
    else{
      for(const predecessor of [...target.predecessors,...target.previousClis]){
        if(!await confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:predecessor}))
          throw new Error('旧 Windows Job 容器仍存活或退出证据缺失，不能交还');
        check();
      }
      if(!target.host.pid)throw new Error('无法确认新普通宿主属于登记的 Windows Job 容器，不能交还');
      const membership=await waitForProcessWindowsJobMembership({dataRoot:ports.dataRoot,allocationId:target.host.allocationId,pid:target.host.pid});
      if(membership==='not-member')throw new Error('新普通宿主不属于登记的 Windows Job 容器，不能交还');
      if(membership==='unknown')throw new Error('暂时无法确认新普通宿主属于登记的 Windows Job 容器，不能交还');
    }
    check();
  } else {
    for(const predecessor of [...target.predecessors,...target.previousClis]) {
      if(!predecessor.pid||!predecessor.marker||!predecessor.groupId)throw new Error('旧宿主身份不完整，不能证明物理交还');
      const members=await inspectProcessGroup(predecessor.groupId);check();
      if(!members||members.length)throw new Error('旧宿主进程组仍存活或无法核对，不能交还');
    }
    const members=await inspectProcessGroup(target.host.groupId!);check();
    if(target.host.groupId!==target.host.pid||members?.some(row=>row.pid===process.pid)
      ||!members?.some(row=>row.pid===target.host.pid&&row.startMarker===target.host.marker))
      throw new Error('新普通宿主实际进程身份不匹配，不能交还');
  }
  check();
  return ports.store.recordRuntimeRepairHandoff(ports.authority,ports.caseId,target.receipt);
}
