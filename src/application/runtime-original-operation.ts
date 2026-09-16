import type Database from 'better-sqlite3';
import {runtimeBusinessBaselineSchema,runtimeOriginalOperationReceiptSchema,
  type RuntimeBusinessBaseline} from '../domain/runtime-business-progress';
import {runtimeRepairHandoffSchema,type RuntimeRepairHandoff} from '../domain/runtime-repair-followup';

const requiredTables=['execution_attempts','loop_lifecycle_state','loop_supervisor_lease','tasks','workflow_items'] as const;

/** Fresh actual ordinary-host business operation for runtime repairs whose
 * frozen failure scope had no Work Item. This is a readonly protocol/lease
 * read, not a heartbeat, display state, migration or invented completion. */
export function readRuntimeOriginalOperationInDb(db:Database.Database,input:{
  baseline:RuntimeBusinessBaseline;handoff:RuntimeRepairHandoff;originalObservationIds:string[];
  assertCurrent:()=>void;now?:()=>number;
}){
  if(!db.readonly)throw new Error('原运行操作验证必须使用 readonly 连接');
  const baseline=runtimeBusinessBaselineSchema.parse(input.baseline),handoff=runtimeRepairHandoffSchema.parse(input.handoff);
  if(baseline.tasks.length)throw new Error('有原工作项时必须观察正常业务推进，不能用 runtime 操作代替');
  const originalObservationIds=[...input.originalObservationIds].sort();
  if(!originalObservationIds.length||new Set(originalObservationIds).size!==originalObservationIds.length)
    throw new Error('原运行操作缺少完整原验收来源');
  return db.transaction(()=>{
    input.assertCurrent();
    const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    if(requiredTables.some(table=>!tables.includes(table)))throw new Error('实际业务库未完成原运行协议初始化');
    const lease=db.prepare('SELECT owner_id,fencing_token,expires_at FROM loop_supervisor_lease WHERE singleton=1').get() as
      {owner_id:string;fencing_token:number;expires_at:string}|undefined;
    const lifecycle=db.prepare(`SELECT desired_intent,intent_revision,mode,actual_phase,active_run_id,last_error
      FROM loop_lifecycle_state WHERE singleton=1`).get() as {desired_intent:string;intent_revision:number;mode:string;
        actual_phase:string;active_run_id:string|null;last_error:string|null}|undefined;
    if(!lease||lease.fencing_token!==handoff.businessSupervisionToken||!Number.isFinite(Date.parse(lease.expires_at))
      ||Date.parse(lease.expires_at)<=(input.now??Date.now)())throw new Error('当前普通宿主没有实际新鲜监督 lease');
    if(!lifecycle||lifecycle.mode!=='normal'||lifecycle.actual_phase==='crashed'||lifecycle.last_error!==null)
      throw new Error('当前普通宿主未完成健康业务生命周期操作');
    const userVersion=(db.pragma('user_version',{simple:true}) as number);
    const receipt=runtimeOriginalOperationReceiptSchema.parse({caseId:baseline.caseId,
      verificationAttemptId:baseline.verificationAttemptId,updateId:baseline.updateId,artifact:baseline.candidateArtifact,
      handoff,originalObservationIds,businessStoreBefore:baseline.businessStore,businessStoreAfter:'present',
      databaseUserVersion:userVersion,schemaTables:[...requiredTables],
      supervision:{ownerId:lease.owner_id,fencingToken:lease.fencing_token,expiresAt:lease.expires_at},
      lifecycle:{desiredIntent:lifecycle.desired_intent,intentRevision:lifecycle.intent_revision,mode:lifecycle.mode,
        actualPhase:lifecycle.actual_phase,activeRunId:lifecycle.active_run_id,lastError:lifecycle.last_error}});
    input.assertCurrent();return receipt;
  })();
}
