import {z} from 'zod';
import {runtimeArtifactSchema} from './runtime-update';

const id=z.string().trim().min(1).max(200);
export const runtimeRepairBaselineSchema=z.object({
  previousHostAllocationIds:z.array(id),previousUpdateAllocationIds:z.array(id),previousCliAllocationIds:z.array(id),
  hostSequence:z.number().int().nonnegative(),
}).strict();
/** Physical admission evidence only. No result, acceptance or completion. */
export const runtimeRepairHandoffSchema=z.object({
  caseId:id,verificationAttemptId:id,updateId:id,artifact:runtimeArtifactSchema,
  installationRevision:z.number().int().positive(),hostAllocationId:id,
  hostSequence:z.number().int().positive(),rootOwnerId:id,rootToken:z.number().int().positive(),
  pid:z.number().int().positive(),marker:id,groupId:z.number().int().positive(),
  parentPid:z.number().int().positive(),businessSupervisionToken:z.number().int().positive(),
}).strict();
export type RuntimeRepairHandoff=z.infer<typeof runtimeRepairHandoffSchema>;
