import {z} from 'zod';
import type {AdminAuthority} from './repair-case';
import type {RuntimeArtifact,RuntimeHostAuthority} from './runtime-update';

const id=z.string().trim().min(1).max(200);
export const adminBusinessRequestSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('configuration')}).strict(),
  z.object({operation:z.literal('discover')}).strict(),
  z.object({operation:z.literal('actions')}).strict(),
  z.object({operation:z.literal('reconcile-takeovers')}).strict(),
  z.object({operation:z.literal('harness-actions')}).strict(),
  z.object({operation:z.literal('harness-build')}).strict(),
  z.object({operation:z.literal('followups')}).strict(),
  z.object({operation:z.literal('host-audit'),updateAllocationId:z.string().uuid().optional()}).strict(),
  z.object({operation:z.literal('assert-workspace'),caseId:id,inputHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({operation:z.literal('assert-runtime'),caseId:id,inputHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({operation:z.literal('runtime-business-baseline'),updateId:id}).strict(),
  z.object({operation:z.literal('runtime-business-progress'),caseId:id}).strict(),
]);
export type AdminBusinessRequest=z.infer<typeof adminBusinessRequestSchema>;
export type AdminBusinessWorkerRecord={
  allocationId:string;rootAuthority:RuntimeHostAuthority;managementAuthority:AdminAuthority;
  intentRevision:number;artifact:RuntimeArtifact;operation:AdminBusinessRequest['operation'];
  parentPid:number;pid:number|null;marker:string|null;groupId:number|null;
  status:'launching'|'bound'|'exited';
};

export const adminWorkerLane=(operation:AdminBusinessRequest['operation'])=>operation==='harness-build'?'harness-build':'business';
/** Cross-lane overlap never waives an unknown allocation or old authority. */
export function parallelAdminWorker(record:AdminBusinessWorkerRecord,operation:AdminBusinessRequest['operation'],
  root:RuntimeHostAuthority,management:AdminAuthority,intentRevision:number){
  return adminWorkerLane(record.operation)!==adminWorkerLane(operation)&&record.status==='bound'&&!!record.pid&&!!record.marker
    &&record.rootAuthority.ownerId===root.ownerId&&record.rootAuthority.token===root.token
    &&record.managementAuthority.ownerId===management.ownerId&&record.managementAuthority.token===management.token
    &&record.intentRevision===intentRevision;
}
