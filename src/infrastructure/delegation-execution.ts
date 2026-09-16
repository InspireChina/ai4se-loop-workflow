import { executeAgentInvocation, type DelegationExecutionInput } from "./agent-invocation";
import { databaseConnection,paths } from "./database";
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AdminManagementStore} from './admin-management-store';
import {assertRuntimeCliCaller} from './runtime-cli-registry';
import { markManagedAgentProcessExited, registerManagedAgentProcess } from "./managed-process-registry";
import { terminateProcessGroup, terminateProcessGroupTree, terminateProcessTree } from "./process-tree";
import {createBusinessExecutionActivityInDb} from '../application/business-execution-activity';
import { attachExecutionProcessInDb, finishExecutionProcessInDb, prepareExecutionProcessInDb, requestExecutionProcessTerminationInDb } from "../application/execution-processes";
export { createTemporaryPrompt, removeTemporaryPrompt, buildAgentProcessLaunch } from "./agent-invocation";
export type { DelegationExecutionInput, DelegationExecutionResult } from "./agent-invocation";

/** Business composition; the invocation core also supports independent management adapters. */
export async function executeDelegation(input: DelegationExecutionInput) {
  const activity=input.executionId?createBusinessExecutionActivityInDb(await databaseConnection(),{
    executionId:input.executionId,runId:input.runId,context:input.context,
    timeoutMs:input.activityTimeoutMs,pollIntervalMs:input.activityPollIntervalMs,
  }):undefined;
  const hostAllocationId=process.env.LOOP_RUNTIME_HOST_ALLOCATION;
  const management=hostAllocationId?new AdminManagementStore(join(paths.dataDir,'admin-management.db')):undefined;
  const usesGroup = Boolean(input.executionId || input.isolateProcessGroup || management) && process.platform !== "win32";
  const baseProcesses = input.processes ?? {
    register: registerManagedAgentProcess,
    markExited: markManagedAgentProcessExited,
    terminate: usesGroup ? terminateProcessGroupTree : terminateProcessTree,
    ...(usesGroup ? { confirmExit: terminateProcessGroupTree } : {}),
  };
  // Host-owned POSIX CLI groups need actual OS exit proof even when a caller
  // overrides the business registry adapter. Root close or custom true is not
  // enough to settle the independent ledger.
  const processes=management&&usesGroup?{...baseProcesses,terminate:terminateProcessGroupTree,confirmExit:terminateProcessGroupTree}:baseProcesses;
  const allocation = input.executionId ? { prepare: async () => {
    const db = await databaseConnection();
    const id = prepareExecutionProcessInDb(db, input.executionId!, process.pid,
      Number(process.env.LOOP_SUPERVISION_TOKEN || 0), { runId: input.runId, taskId: input.context.taskId });
    try {
      if(management&&hostAllocationId) {
        await assertRuntimeCliCaller(management,hostAllocationId);
        management.reserveRuntimeCli(hostAllocationId,id,input.executionId!,process.pid);
      }
    }catch(error){finishExecutionProcessInDb(db,id,true);throw error;} // no spawn occurred
    return {
      containment:{dataRoot:paths.dataDir,allocationId:id},
      attach: (pid: number, marker?: string, groupId?: number) => { management?.attachRuntimeCli(id,pid,marker,groupId);attachExecutionProcessInDb(db, id, pid, marker, groupId); },
      requestTermination: (reason: string) => { management?.finishRuntimeCli(id,false);requestExecutionProcessTerminationInDb(db, id, reason); },
      finish: (confirmed: boolean, reason?: string) => { management?.finishRuntimeCli(id,confirmed);finishExecutionProcessInDb(db, id, confirmed, reason); },
    };
  } } : management&&hostAllocationId?{prepare:async()=>{
    const prior=await input.allocation?.prepare();const id=randomUUID();
    try{
      await assertRuntimeCliCaller(management,hostAllocationId);
      management.reserveRuntimeCli(hostAllocationId,id,`invocation:${input.runId}:${id}`,process.pid);
    }catch(error){prior?.finish(true,'独立管理分配拒绝，尚未 spawn');throw error;}
    return {
      containment:{dataRoot:paths.dataDir,allocationId:id},
      attach:(pid:number,marker?:string,groupId?:number)=>{management.attachRuntimeCli(id,pid,marker,groupId);prior?.attach(pid,marker,groupId);},
      requestTermination:(reason:string)=>{management.finishRuntimeCli(id,false);prior?.requestTermination(reason);},
      finish:(confirmed:boolean,reason?:string)=>{management.finishRuntimeCli(id,confirmed);prior?.finish(confirmed,reason);},
    };
  }}:input.allocation;
  try{return await executeAgentInvocation({ ...input, processes, allocation,isolateProcessGroup:input.isolateProcessGroup||!!management,
    ...(activity?{
      monitor:{intervalMs:Math.min(activity.intervalMs,input.monitor?.intervalMs??activity.intervalMs),
        get failureKind(){return activity.failure()?activity.failureKind:input.monitor?.failureKind;},
        begin:()=>{activity.begin();input.monitor?.begin?.();},
        observe:event=>{activity.observe(event);input.monitor?.observe(event);},
        failure:()=>activity.failure()??input.monitor?.failure()??null},
      recordTelemetryEvent:async event=>{await activity.persist();await input.recordTelemetryEvent?.(event);},
    }:{}),
  });}
  finally{management?.close();}
}
