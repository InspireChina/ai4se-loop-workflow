import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {AdminBusinessRequest} from '../domain/admin-business-worker';
import type {AdminAuthority} from '../domain/repair-case';
import type {AdminManagementStore} from './admin-management-store';
import {databaseConnection} from './database';
import {agentExecutionOptions,getAgentExecutorSettings,listSystemRuntimeConfigurations} from '../application/project-settings';
import {createRepairObservationBridge} from '../application/repair-observation-bridge';
import {acknowledgeRepairObservationInDb,pendingRepairObservationsInDb,rebindRepairCaseCohortInDb} from '../application/repair-observation-outbox';
import {createAdminManagedActions} from '../application/admin-managed-actions';
import {acknowledgeRepairTakeoverRevocationInDb,acquireRepairTakeover,pendingRepairTakeoverRevocationsInDb,
  revokeInvalidRepairTakeoversInDb} from '../application/repair-takeover';
import {createAdminHandoffs} from '../application/admin-handoff';
import {handoffVerifiedRepair,observeRepairHandoffProgressInDb} from '../application/repair-handoff';
import {readRepairWorkspaceVersion} from './repair-workspace-version';
import {observeRepairBusinessReadinessInDb,holdStalledRepairBusinessInDb} from '../application/repair-business-watch';
import {assertIndependentVerificationWorkspaceInDb} from '../application/independent-verification-workspace';
import {independentPreparationHash} from '../domain/independent-verification-preparation';
import Database from 'better-sqlite3';
import {runtimeHostAuditSchema} from '../domain/runtime-host-audit';
import {runtimeHostHealthSchema} from '../domain/runtime-host-health';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {inspectProcessIdentity} from './process-tree';
import {readBusinessLifecycleObservation} from './business-lifecycle-observation';

/** Shared direct/worker composition for the cross-database repair protocols.
 * Business writes are replayable and management writes stay authority-fenced. */
export async function reconcileAdminBusinessTakeovers(ports:{
  db:Database.Database;store:AdminManagementStore;authority:AdminAuthority;guard?:()=>void;
}){
  const {db,store}=ports;const guard=ports.guard||(()=>undefined);
  const activeAttemptIds=(caseId:string)=>store.attempts(caseId)
    .filter(attempt=>['launching','running'].includes(attempt.status)).map(attempt=>attempt.attemptId);
  const requestedStops=new Set<string>();
  const preferred=(db.prepare('SELECT DISTINCT case_id AS caseId FROM repair_resource_claims').all() as {caseId:string}[])
    .map(row=>row.caseId);
  for(const cohort of store.workItemCaseCohorts(ports.authority,preferred)){
    if(cohort.activeAttemptIds.length){cohort.activeAttemptIds.forEach(id=>requestedStops.add(id));continue;}
    rebindRepairCaseCohortInDb(db,cohort.canonicalCaseId,cohort.aliasCaseIds);guard();
    store.mergeWorkItemCaseCohort(ports.authority,cohort);
  }
  for(const receipt of pendingRepairTakeoverRevocationsInDb(db).filter(receipt=>Boolean(store.getCase(receipt.caseId)))){
    if(store.repairTakeoverRevocationNeedsCaseStop(receipt))activeAttemptIds(receipt.caseId).forEach(id=>requestedStops.add(id));
  }
  const outcomes=await revokeInvalidRepairTakeoversInDb({db,ownerStopped:owner=>activeAttemptIds(owner.case_id).length===0});
  guard();
  for(const outcome of outcomes.filter(row=>row.status==='owner-running')){
    activeAttemptIds(outcome.owner.case_id).forEach(id=>requestedStops.add(id));
  }
  let delivered=0;
  for(const receipt of pendingRepairTakeoverRevocationsInDb(db).filter(receipt=>Boolean(store.getCase(receipt.caseId)))){
    const active=activeAttemptIds(receipt.caseId);
    if(active.length&&store.repairTakeoverRevocationNeedsCaseStop(receipt)){
      active.forEach(id=>requestedStops.add(id));continue;
    }
    store.recordRepairTakeoverRevocation(ports.authority,receipt);guard();
    acknowledgeRepairTakeoverRevocationInDb(db,receipt.eventKey);delivered++;
  }
  return {attemptIds:[...requestedStops],revoked:delivered,
    draining:outcomes.filter(row=>row.status==='draining').length};
}

/** Loaded only by the capability child. Existing trusted business use-cases
 * retain their original validation and physical ownership rules. */
export function createAdminBusinessOperations(ports:{
  store:AdminManagementStore;authority:AdminAuthority;appRoot:string;assertCurrent:()=>void;
}) {
  const guard=ports.assertCurrent;
  // Every management fact written from a capability is fenced to both owners.
  // The raw store is retained by the entrypoint solely for final close.
  const store=new Proxy(ports.store,{get(target,key){
    const value=Reflect.get(target,key);
    if(typeof value!=='function')return value;
    return (...args:unknown[])=>{guard();const result=value.apply(target,args);guard();return result;};
  }});
  const bridge=createRepairObservationBridge({pending:async()=>pendingRepairObservationsInDb(await databaseConnection()).map(row=>JSON.parse(row.observation_json)),
    observe:observation=>store.observe(observation),acknowledge:async(id,caseId)=>{
      const db=await databaseConnection();guard();return db.transaction(()=>{guard();const result=acknowledgeRepairObservationInDb(db,id,caseId);guard();return result;}).immediate();
    }});
  const actions=createAdminManagedActions({store,takeover:async(target,assertCurrent,previousOwnerStopped)=>{
    const db=await databaseConnection();guard();return acquireRepairTakeover({db,target,
      assertCurrent:value=>{guard();assertCurrent(value);},previousOwnerStopped});
  }});
  let followupError:unknown;
  const followups=createAdminHandoffs({store,onError:error=>{followupError=error;},
    handoff:async(target,assertCurrent)=>{const db=await databaseConnection();guard();return handoffVerifiedRepair({db,target,
      assertCurrent:()=>{guard();assertCurrent();},readVersion:root=>readRepairWorkspaceVersion(root,{assertCurrent:guard})});},
    observeProgress:async receipt=>{const db=await databaseConnection();guard();const readCurrent=()=>{guard();return observeRepairHandoffProgressInDb(db,receipt);};
      return {progress:readCurrent(),readCurrent,readiness:observeRepairBusinessReadinessInDb(db,receipt)};},
    holdStalled:async(receipt,fingerprint,assertCurrent)=>{const db=await databaseConnection();guard();
      const observation=holdStalledRepairBusinessInDb(db,receipt,fingerprint,()=>{guard();assertCurrent();});
      return observation?{observation,acknowledge:async()=>{guard();return acknowledgeRepairObservationInDb(db,observation.observationId,receipt.target.caseId);}}:null;},
  });
  return async(request:AdminBusinessRequest)=>{
    guard();let result:unknown=null;
    switch(request.operation){
      case 'configuration':{
        const version=JSON.parse(await readFile(join(ports.appRoot,'package.json'),'utf8')).version;
        if(typeof version!=='string'||!version.trim())throw new Error('配置能力无法定位实际版本');
        const settings=await getAgentExecutorSettings();guard();
        result={configuration:{configurationId:settings.configurationId,sourceVersion:version,executorId:settings.executorId,executionOptions:agentExecutionOptions(settings)},
          alternatives:listSystemRuntimeConfigurations().map(setting=>({configurationId:setting.configurationId,sourceVersion:version,executorId:setting.executorId,executionOptions:agentExecutionOptions(setting)}))};break;
      }
      case 'discover':result={delivered:await bridge()};break;
      case 'actions':await actions(ports.authority);break;
      case 'reconcile-takeovers':{
        const db=await databaseConnection();guard();
        result=await reconcileAdminBusinessTakeovers({db,store,authority:ports.authority,guard});break;
      }
      case 'followups':await followups(ports.authority);if(followupError)throw followupError;break;
      case 'host-audit':{
        // No migrations, PRAGMA changes or environment-selected DB. This
        // diagnostic must also work while business/update intent is stopped.
        let db:Database.Database|undefined;
        try{
          db=new Database(join(process.env.LOOP_DATA_ROOT!,'loop-ui.db'),{readonly:true,fileMustExist:true});
          const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
          const knownProtocol=tables.has('loop_managed_processes')&&tables.has('loop_runs')&&tables.has('execution_processes');
          const audit=runtimeHostAuditSchema.parse({databasePresent:true,knownProtocol,
            lifecycle:readBusinessLifecycleObservation(db),
            managed:knownProtocol?db.prepare("SELECT process_id AS id,process_kind AS kind,pid,process_start_marker AS marker,supervision_token AS supervisionToken FROM loop_managed_processes WHERE status='running' LIMIT 5001").all():[],
            executions:knownProtocol?db.prepare("SELECT allocation_id AS id,pid,process_start_marker AS marker,process_group_id AS groupId FROM execution_processes WHERE status<>'exited' LIMIT 5001").all():[],
            runs:knownProtocol?db.prepare("SELECT run_id AS id,runner_pid AS pid,supervision_token AS supervisionToken FROM loop_runs WHERE status IN ('starting','running','stopping') LIMIT 5001").all():[]});
          if(request.updateAllocationId){
            const allocation=store.runtimeUpdateProcessAllocation(request.updateAllocationId);
            if(!knownProtocol||!allocation?.pid||!allocation.marker||allocation.status==='exited'||allocation.parentPid!==process.ppid)
              throw new Error('旧协议健康读取缺少当前实际父宿主分配与进程身份');
            const checkSource=()=>{
              guard();store.assertRuntimeUpdate(allocation.authority);
              const current=store.runtimeUpdateProcessAllocation(allocation.allocationId);
              if(!current||current.status==='exited'||current.pid!==allocation.pid||current.marker!==allocation.marker
                ||current.parentPid!==allocation.parentPid||JSON.stringify(current.authority)!==JSON.stringify(allocation.authority)
                ||JSON.stringify(current.artifact)!==JSON.stringify(allocation.artifact))throw new Error('旧协议健康读取期间宿主来源改变');
            };
            const inspect=async()=>{checkSource();const identity=await inspectProcessIdentity(allocation.pid!);checkSource();
              if(identity?.startMarker!==allocation.marker)throw new Error('旧协议宿主实际进程身份不匹配');};
            await inspect();
            const actual=await readHarnessArtifact(allocation.artifact.root,{assertCurrent:checkSource});
            if(JSON.stringify(actual)!==JSON.stringify(allocation.artifact))throw new Error('旧协议宿主实际产物不匹配');
            await inspect();
            // Artifact hashing/identity inspection may take seconds. Do not
            // certify silence using activity read before those awaits.
            audit.managed=db.prepare("SELECT process_id AS id,process_kind AS kind,pid,process_start_marker AS marker,supervision_token AS supervisionToken FROM loop_managed_processes WHERE status='running' LIMIT 5001").all() as typeof audit.managed;
            audit.executions=db.prepare("SELECT allocation_id AS id,pid,process_start_marker AS marker,process_group_id AS groupId FROM execution_processes WHERE status<>'exited' LIMIT 5001").all() as typeof audit.executions;
            audit.runs=db.prepare("SELECT run_id AS id,runner_pid AS pid,supervision_token AS supervisionToken FROM loop_runs WHERE status IN ('starting','running','stopping') LIMIT 5001").all() as typeof audit.runs;
            const lease=db.prepare('SELECT owner_id,fencing_token,expires_at FROM loop_supervisor_lease WHERE singleton=1').get() as
              {owner_id:string;fencing_token:number;expires_at:string}|undefined;
            const state=db.prepare('SELECT mode,active_run_id,actual_phase,last_error FROM loop_lifecycle_state WHERE singleton=1').get() as
              {mode:string;active_run_id:string|null;actual_phase:string;last_error:string|null}|undefined;
            if(!lease||!state||audit.runs.length||audit.executions.length||audit.managed.some(row=>row.kind==='agent-cli'))
              throw new Error('旧协议宿主缺少监督状态或更新静默下仍有活动执行');
            audit.legacyHealth=runtimeHostHealthSchema.parse({version:actual.version,
              owner:new RegExp(`^hosted-${allocation.pid}-[a-f0-9-]{36}$`).test(lease.owner_id),
              token:lease.fencing_token,leaseExpiresAt:lease.expires_at,managementMode:store.control().management_mode,
              businessMode:state.mode,updatePending:store.activeRuntimeUpdate()?.request.updateId===allocation.authority.updateId,
              runId:state.active_run_id,runPhase:state.actual_phase,lastError:state.last_error});
            checkSource();
          }
          result=audit;
        }catch(error){
          if((error as NodeJS.ErrnoException).code!=='SQLITE_CANTOPEN')throw error;
          // Distinguish a truly absent file from access/format failure.
          const {stat}=await import('node:fs/promises');
          try{await stat(join(process.env.LOOP_DATA_ROOT!,'loop-ui.db'));throw error;}
          catch(reason){if((reason as NodeJS.ErrnoException).code!=='ENOENT')throw reason;}
          result={databasePresent:false,knownProtocol:false,managed:[],executions:[],runs:[]};
          if(request.updateAllocationId)throw new Error('旧协议健康读取缺少实际业务数据库');
        }finally{db?.close();}
        break;
      }
      case 'assert-workspace':{
        const claim=store.currentIndependentVerificationClaim(ports.authority,request.caseId);
        const input=store.independentVerificationInput(claim);
        if(independentPreparationHash(input)!==request.inputHash)throw new Error('独立验收来源指纹已改变');
        const db=await databaseConnection();guard();assertIndependentVerificationWorkspaceInDb(db,request.caseId,input);result=true;break;
      }
    }
    guard();return result;
  };
}
