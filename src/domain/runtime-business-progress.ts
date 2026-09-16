import {z} from 'zod';
import {runtimeRepairHandoffSchema} from './runtime-repair-followup';
import {runtimeArtifactSchema} from './runtime-update';

const id=z.string().trim().min(1).max(200);
const item=z.object({itemId:id,revision:z.number().int().positive(),dispatchEpoch:z.number().int().positive(),
  previousExecutionIds:z.array(id),workKey:id.optional(),kind:id.optional(),storyIndex:z.number().int().nullable().optional(),
  predecessors:z.array(z.object({itemId:id,revision:z.number().int().positive()}).strict()).min(1).optional()}).strict();
/** Frozen after ordinary writers physically exit, before candidate admission.
 * Empty original work is not evidence of business recovery. */
export const runtimeBusinessBaselineSchema=z.object({
  schemaVersion:z.literal(1),caseId:id,verificationAttemptId:id,updateId:id,
  candidateArtifact:runtimeArtifactSchema,
  businessStore:z.enum(['present','absent']).default('present'),
  originalBoundaryMs:z.number().int().nonnegative(),
  originalStartBoundaryMs:z.number().int().nonnegative().optional(),
  tasks:z.array(z.object({taskId:id,items:z.array(item).min(1)}).strict()),
}).strict().superRefine((value,ctx)=>{
  if((value.originalStartBoundaryMs??value.originalBoundaryMs)>value.originalBoundaryMs)
    ctx.addIssue({code:'custom',message:'原故障时间范围不能倒置'});
  if(value.businessStore==='absent'&&value.tasks.length)
    ctx.addIssue({code:'custom',message:'不存在的业务库不能包含虚构需求'});
  const tasks=new Set<string>(),items=new Set<string>();
  for(const task of value.tasks){
    if(tasks.has(task.taskId))ctx.addIssue({code:'custom',message:'原业务需求基线不能重复'});
    tasks.add(task.taskId);
    for(const item of task.items){
      if(items.has(item.itemId)||new Set(item.previousExecutionIds).size!==item.previousExecutionIds.length)
        ctx.addIssue({code:'custom',message:'原业务工作项或执行基线不能重复'});
      items.add(item.itemId);
      const chain=item.predecessors??[];
      if(chain.length&&(!item.workKey||!item.kind||item.storyIndex===undefined
        ||new Set([...chain.map(row=>row.itemId),item.itemId]).size!==chain.length+1
        ||chain.some((row,index)=>row.revision>=(chain[index+1]?.revision??item.revision))))
        ctx.addIssue({code:'custom',message:'原工作项回退链必须保持身份、顺序及递增 revision'});
    }
  }
});
export type RuntimeBusinessBaseline=z.infer<typeof runtimeBusinessBaselineSchema>;

/** Candidate evidence only: the native management boundary must independently
 * revalidate the saved handback, actual CLI exit and installed bytes. */
export const runtimeBusinessProgressCandidateSchema=z.object({
  taskId:id,itemId:id,itemRevision:z.number().int().positive(),dispatchEpoch:z.number().int().positive(),
  executionId:id,resultId:id,completionEventId:id,handoff:runtimeRepairHandoffSchema,
  cli:z.object({allocationId:id,hostAllocationId:id,executionId:id,ownerPid:z.number().int().positive(),
    pid:z.number().int().positive(),marker:id,groupId:z.number().int().positive(),status:z.literal('exited')}).strict(),
}).strict().superRefine((value,ctx)=>{
  if(value.cli.executionId!==value.executionId||value.cli.hostAllocationId!==value.handoff.hostAllocationId
    ||value.cli.pid===value.handoff.pid||value.cli.pid===value.handoff.parentPid||value.cli.ownerPid===value.handoff.parentPid)
    ctx.addIssue({code:'custom',message:'业务执行与实际 CLI/交还宿主来源不一致'});
});
export type RuntimeBusinessProgressCandidate=z.infer<typeof runtimeBusinessProgressCandidateSchema>;

/** A no-Work-Item runtime repair still needs an actual ordinary-host
 * operation after activation. This receipt binds the freshly opened business
 * protocol and lifecycle lease to the same physical handoff and all original
 * independently verified observations; an empty task list is never enough. */
export const runtimeOriginalOperationReceiptSchema=z.object({
  caseId:id,verificationAttemptId:id,updateId:id,artifact:runtimeArtifactSchema,
  handoff:runtimeRepairHandoffSchema,originalObservationIds:z.array(id).min(1),
  businessStoreBefore:z.enum(['present','absent']),businessStoreAfter:z.literal('present'),
  databaseUserVersion:z.number().int().nonnegative(),schemaTables:z.array(id).min(5),
  supervision:z.object({ownerId:id,fencingToken:z.number().int().positive(),expiresAt:id}).strict(),
  lifecycle:z.object({desiredIntent:z.enum(['running','stopped']),intentRevision:z.number().int().nonnegative(),
    mode:z.literal('normal'),actualPhase:z.enum(['starting','running','stopping','stopped']),
    activeRunId:id.nullable(),lastError:z.null()}).strict(),
}).strict().superRefine((value,ctx)=>{
  if(value.handoff.caseId!==value.caseId||value.handoff.verificationAttemptId!==value.verificationAttemptId
    ||value.handoff.updateId!==value.updateId||JSON.stringify(value.handoff.artifact)!==JSON.stringify(value.artifact)
    ||value.handoff.businessSupervisionToken!==value.supervision.fencingToken)
    ctx.addIssue({code:'custom',message:'原运行操作与实际交还、安装或监督代次不一致'});
  if(new Set(value.originalObservationIds).size!==value.originalObservationIds.length
    ||new Set(value.schemaTables).size!==value.schemaTables.length
    ||value.schemaTables.some((table,index)=>index&&table<=value.schemaTables[index-1]))
    ctx.addIssue({code:'custom',message:'原运行操作必须绑定不重复的完整验收与有序协议表'});
});
export type RuntimeOriginalOperationReceipt=z.infer<typeof runtimeOriginalOperationReceiptSchema>;

/** Derived authority invalidation, not a replacement original acceptance. */
export const runtimeBusinessCohortChangeSchema=z.object({
  taskId:id,originalItemId:id,originalRevision:z.number().int().positive(),
  current:z.object({itemId:id,revision:z.number().int().positive(),dispatchEpoch:z.number().int().positive(),
    status:z.enum(['pending','ready','running','waiting','completed','superseded','cancelled']),
    origin:z.enum(['native','legacy_projection']),workKey:id.nullable(),kind:id.nullable(),
    storyIndex:z.number().int().nullable(),successorId:id.nullable()}).strict().nullable(),
}).strict();
export type RuntimeBusinessCohortChange=z.infer<typeof runtimeBusinessCohortChangeSchema>;

const dispatchItem=z.object({itemId:id,revision:z.number().int().positive(),dispatchEpoch:z.number().int().positive()}).strict();
export const runtimeBusinessDispatchSnapshotSchema=z.object({
  progress:z.array(runtimeBusinessProgressCandidateSchema),
  observations:z.array(z.object({taskId:id,readiness:z.enum(['runnable','executing','waiting','paused','ended']),
    runnableItems:z.array(dispatchItem)}).strict().superRefine((value,ctx)=>{
    if((value.readiness==='runnable')!==(value.runnableItems.length>0)
      ||new Set(value.runnableItems.map(item=>item.itemId)).size!==value.runnableItems.length)
      ctx.addIssue({code:'custom',message:'可派发观察必须绑定真实且不重复的原工作项'});
  })),
}).strict();
export type RuntimeBusinessDispatchSnapshot=z.infer<typeof runtimeBusinessDispatchSnapshotSchema>;

export function runtimeBusinessCohortInvalidated(original:RuntimeBusinessBaseline['tasks'][number]['items'][number],
  current:RuntimeBusinessCohortChange['current']) {
  return !current||current.revision!==original.revision||current.dispatchEpoch<original.dispatchEpoch
    ||current.origin!=='native'||['superseded','cancelled'].includes(current.status)
    ||original.workKey!==undefined&&current.workKey!==original.workKey
    ||original.kind!==undefined&&current.kind!==original.kind
    ||original.storyIndex!==undefined&&current.storyIndex!==original.storyIndex;
}

export const runtimeBusinessProgressResultSchema=z.object({
  status:z.enum(['waiting','closed','source-changed']),verificationAttemptId:id,
  progressCount:z.number().int().nonnegative(),requiredCount:z.number().int().nonnegative(),
}).strict();
