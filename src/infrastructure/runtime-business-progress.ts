import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import type {AdminAuthority} from '../domain/repair-case';
import type {AdminManagementStore} from './admin-management-store';
import {findRuntimeBusinessProgressCandidatesInDb,findRuntimeBusinessCohortChangesInDb} from '../application/runtime-business-progress';
import {readRuntimeBusinessDispatchInDb} from '../application/runtime-business-dispatch';
import {readRuntimeOriginalOperationInDb} from '../application/runtime-original-operation';
import {assertRuntimeVerificationInput} from './runtime-verification-input';
import {inspectProcessGroup} from './process-tree';
import {runtimeBusinessProgressResultSchema} from '../domain/runtime-business-progress';
import {confirmWindowsJobContainmentExit,waitForProcessWindowsJobMembership} from './windows-job-containment';

class ProgressSourceChanged extends Error {}

/** Stable Root capability child, read-only business connection. Physical
 * proof precedes persistence; a final consistent read precedes atomic close.
 * Unrelated ordinary allocations do not invalidate an already exited CLI. */
export async function observeRuntimeBusinessProgress(ports:{
  store:AdminManagementStore;authority:AdminAuthority;caseId:string;dataRoot:string;
  assertCurrent:()=>void;signal?:AbortSignal;
}) {
  const target=ports.store.runtimeBusinessProgressTarget(ports.authority,ports.caseId);
  const verificationAttemptId=target?.baseline.verificationAttemptId
    ??ports.store.verifiedRuntimeUpdateInput(ports.authority,ports.caseId).verificationAttemptId;
  const requiredCount=target?.baseline.tasks.length??0;
  const result=(status:'waiting'|'closed'|'source-changed',progressCount=0)=>runtimeBusinessProgressResultSchema.parse({
    status,verificationAttemptId,progressCount,requiredCount});
  if(!target)return result('waiting');
  const check=()=>{
    ports.signal?.throwIfAborted();ports.assertCurrent();
    const current=ports.store.runtimeBusinessProgressTarget(ports.authority,ports.caseId);
    if(!current||JSON.stringify(current.baseline)!==JSON.stringify(target.baseline)
      ||JSON.stringify(current.receipt)!==JSON.stringify(target.receipt)
      ||target.handoffs.some(saved=>!current.handoffs.some(row=>JSON.stringify(row)===JSON.stringify(saved))))
      throw new ProgressSourceChanged('业务恢复的实际版本或宿主代次已改变');
    return current;
  };
  const checkHost=async()=>{
    if(process.platform==='win32'){
      const membership=await waitForProcessWindowsJobMembership({dataRoot:ports.dataRoot,allocationId:target.host.allocationId,pid:target.host.pid!});
      if(membership==='not-member')throw new Error('业务恢复的当前普通宿主不属于登记的 Windows Job 容器');
      if(membership==='unknown')throw new Error('暂时无法确认业务恢复的当前普通宿主属于登记的 Windows Job 容器');
      check();return;
    }
    const members=await inspectProcessGroup(target.host.groupId!);check();
    if(target.host.groupId!==target.host.pid||members?.some(row=>row.pid===process.ppid)
      ||!members?.some(row=>row.pid===target.host.pid&&row.startMarker===target.host.marker))
      throw new Error('业务恢复的当前普通宿主实际身份不匹配');
  };
  try{
    check();
    if(target.host.parentPid!==process.ppid||target.host.pid===process.ppid)
      throw new Error('业务恢复只能由当前实际父 Root 的能力子进程观察');
    await assertRuntimeVerificationInput(target.input,{store:ports.store,caseId:ports.caseId,
      dataRoot:ports.dataRoot,signal:ports.signal,assertCurrent:check});check();
    await checkHost();
    const filename=join(ports.dataRoot,'loop-ui.db'),file=await lstat(filename);check();
    if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1)throw new Error('业务恢复数据库必须是独立实际文件');
    const db=new Database(filename,{readonly:true,fileMustExist:true});
    try{
      if(!requiredCount){
        const originalObservationIds=target.input.originalObservations.map(row=>row.observationId);
        const readOriginal=()=>readRuntimeOriginalOperationInDb(db,{baseline:check().baseline,handoff:check().receipt,
          originalObservationIds,assertCurrent:check});
        const receipt=readOriginal();
        await assertRuntimeVerificationInput(target.input,{store:ports.store,caseId:ports.caseId,
          dataRoot:ports.dataRoot,signal:ports.signal,assertCurrent:check});check();
        await checkHost();
        const closed=ports.store.closeRuntimeOriginalOperationCase(ports.authority,ports.caseId,receipt,readOriginal);
        return result(closed?'closed':'waiting');
      }
      if(target.baseline.businessStore!=='present')return result('waiting');
      const read=()=>{
        const source=check();
        return findRuntimeBusinessProgressCandidatesInDb(db,{baseline:source.baseline,handoffs:source.handoffs,
          clis:source.clis,assertCurrent:check});
      };
      const candidates=read();
      for(const candidate of candidates){
        const source=check();
        if(!source.clis.some(row=>JSON.stringify(row)===JSON.stringify(candidate.cli)))throw new ProgressSourceChanged('CLI 来源已改变');
        const cliExited=process.platform==='win32'
          ? await confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:candidate.cli})
          : !!candidate.cli.groupId&&await inspectProcessGroup(candidate.cli.groupId).then(members=>!!members&&!members.length);
        check();if(!cliExited)throw new Error('业务 CLI 进程组实际存活或 Windows Job 容器无法核对，禁止确认业务恢复');
      }
      await assertRuntimeVerificationInput(target.input,{store:ports.store,caseId:ports.caseId,
        dataRoot:ports.dataRoot,signal:ports.signal,assertCurrent:check});check();
      await checkHost();
      // Never persist a stale ordinary completion after pause/rewind while
      // native checks were running, even when its process really exited.
      if(JSON.stringify(read())!==JSON.stringify(candidates))return result('source-changed');
      for(const candidate of candidates)ports.store.recordRuntimeBusinessProgress(ports.authority,ports.caseId,candidate);
      const readChanges=()=>db.transaction(()=>findRuntimeBusinessCohortChangesInDb(db,{baseline:check().baseline,
        progressTaskIds:read().map(candidate=>candidate.taskId),assertCurrent:check}))();
      const changes=readChanges();
      if(changes.length){
        ports.store.recordRuntimeBusinessCohortChange(ports.authority,ports.caseId,changes,readChanges);
        return result('source-changed',candidates.length);
      }
      const closed=ports.store.closeRuntimeObservedCase(ports.authority,ports.caseId,()=>{
        const fresh=read();return JSON.stringify(fresh)===JSON.stringify(candidates)?fresh:[];
      });
      if(closed)return result('closed',candidates.length);
      const readDispatch=()=>db.transaction(()=>readRuntimeBusinessDispatchInDb(db,{baseline:check().baseline,
        progress:read(),assertCurrent:check}))();
      const dispatch=readDispatch();
      const stalled=ports.store.sampleRuntimeBusinessDispatch(ports.authority,ports.caseId,dispatch,readDispatch);
      return result(stalled?'source-changed':'waiting',candidates.length);
    }finally{db.close();}
  }catch(error){if(error instanceof ProgressSourceChanged)return result('source-changed');throw error;}
}
