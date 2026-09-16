import type Database from 'better-sqlite3';
import {businessLifecycleObservationSchema} from '../domain/runtime-host-audit';

/** Called only inside the read-only diagnostic capability. Never initializes
 * state, renews a lease, or infers health from a database phase. */
export function readBusinessLifecycleObservation(db:Database.Database){
  return db.transaction(()=>{
    const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
    if(!tables.has('loop_lifecycle_state')||!tables.has('loop_supervisor_lease')||!tables.has('loop_runs'))return undefined;
    const state=db.prepare(`SELECT desired_intent AS desired,intent_revision AS revision,mode,actual_phase AS phase,
      active_run_id AS runId,restart_count AS restartCount,retry_at AS retryAt,last_error AS lastError,
      update_attempt_id AS updateAttemptId,update_target_version AS targetVersion,update_readiness AS readiness
      FROM loop_lifecycle_state WHERE singleton=1`).get() as {runId:string|null}|undefined;
    if(!state)return undefined;
    const lease=db.prepare('SELECT owner_id AS ownerId,fencing_token AS token,expires_at AS expiresAt FROM loop_supervisor_lease WHERE singleton=1').get()??null;
    const run=state.runId?db.prepare('SELECT status,started_at AS startedAt,heartbeat_at AS heartbeatAt FROM loop_runs WHERE run_id=?').get(state.runId)??null:null;
    return businessLifecycleObservationSchema.parse({...state,lease,run});
  }).deferred();
}
