import {z} from 'zod';

/** Fresh private RPC receipt. Readiness is not business acceptance. */
export const runtimeHostHealthSchema=z.object({
  version:z.string().min(1).max(200),
  owner:z.boolean(),token:z.number().int().positive().nullable(),leaseExpiresAt:z.string().nullable(),
  managementMode:z.enum(['normal','update-silence']),businessMode:z.enum(['normal','update-silence']),
  updatePending:z.boolean(),runId:z.string().nullable(),
  runPhase:z.enum(['starting','running','stopping','stopped','crashed']),lastError:z.string().nullable(),
}).strict();
export type RuntimeHostHealth=z.infer<typeof runtimeHostHealthSchema>;

export function assertHeldHostHealth(input:unknown,version:string,activated:boolean,now=Date.now()){
  const health=runtimeHostHealthSchema.parse(input);
  if(health.version!==version||!health.owner||!health.token||!health.leaseExpiresAt||Date.parse(health.leaseExpiresAt)<=now
    ||!Number.isFinite(Date.parse(health.leaseExpiresAt))||health.managementMode!=='update-silence'||!health.updatePending
    ||activated&&health.businessMode!=='normal'
    ||health.runId!==null||health.runPhase!=='stopped'||health.lastError!==null)
    throw new Error(`候选宿主当前监督、版本或业务静默状态不健康 ${JSON.stringify({
      expectedVersion:version,version:health.version,owner:health.owner,token:health.token,
      leaseExpiresAt:health.leaseExpiresAt,managementMode:health.managementMode,businessMode:health.businessMode,
      activated,updatePending:health.updatePending,
      hasActiveRun:health.runId!==null,runPhase:health.runPhase,hasError:health.lastError!==null,
    })}`);
  return health;
}
