import {createHash,randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import {createRepairActivityMonitor} from '../domain/repair-activity';
import type {AgentExecutionContext,AgentTelemetryEvent} from '../infrastructure/agent-executor';

type Source={execution_id:string;run_id:string;task_id:string;agent:string;pipeline:string;status:string;
  started_at:string|null;work_item_id:string|null;dispatch_generation_key:string|null};
type Event=AgentTelemetryEvent&{sequence:number};

/** Business adapter for the same activity monitor used by independent Admin.
 * Receipt identities survive clean-exit continuations and retries in the same
 * dispatch generation. They prove observable work, NEVER business acceptance.
 * Observe stays in-memory; writes use the invocation's bounded evidence queue,
 * not synchronous OS inspection in stdout/heartbeat callbacks. */
export function createBusinessExecutionActivityInDb(db:Database.Database,input:{
  executionId:string;runId:string;context:AgentExecutionContext;timeoutMs?:number;pollIntervalMs?:number;now?:()=>number;
}) {
  const source=db.prepare('SELECT execution_id,run_id,task_id,agent,pipeline,status,started_at,work_item_id,dispatch_generation_key FROM execution_attempts WHERE execution_id=?')
    .get(input.executionId) as Source|undefined;
  if(!source||source.status!=='running'||source.run_id!==input.runId||source.task_id!==input.context.taskId
    ||source.agent!==input.context.agent||source.pipeline!==input.context.pipeline)throw new Error('Business activity source is not the current running execution');
  if(!source.started_at)throw new Error('Business activity source has no durable start time; cannot reset its deadline');
  const intervalMs=input.pollIntervalMs??1000;
  if(!Number.isFinite(intervalMs)||intervalMs<=0)throw new Error('Business activity poll interval must be positive');
  const scope=source.work_item_id&&source.dispatch_generation_key
    ?{clause:'prior.task_id=? AND prior.agent=? AND prior.pipeline=? AND prior.work_item_id=? AND prior.dispatch_generation_key=?',
      args:[source.task_id,source.agent,source.pipeline,source.work_item_id,source.dispatch_generation_key]}
    :{clause:'prior.execution_id=?',args:[source.execution_id]};
  const rows=db.prepare(`SELECT DISTINCT receipt.receipt_key FROM execution_receipts receipt
    JOIN execution_attempts prior USING(execution_id) WHERE receipt.kind='activity_checkpoint' AND ${scope.clause} LIMIT 5001`)
    .all(...scope.args) as {receipt_key:string}[];
  if(rows.length>5000)throw new Error('Business activity history capacity exceeded; investigation required');
  const known=new Set(rows.map(row=>row.receipt_key));
  const now=input.now??Date.now;
  const timestamp=source.started_at?.replace(' ','T');
  const startedAt=timestamp?Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(timestamp)?timestamp:`${timestamp}Z`):now();
  if(!Number.isFinite(startedAt))throw new Error('Business activity source has an invalid start time');
  const previous=db.prepare(`SELECT payload_json FROM execution_receipts WHERE execution_id=? AND kind='activity_checkpoint'
    ORDER BY rowid DESC LIMIT 1`).get(source.execution_id) as {payload_json:string}|undefined;
  const lastCheckpoint=previous?JSON.parse(previous.payload_json).checkpointAtMs:startedAt;
  if(!Number.isFinite(lastCheckpoint))throw new Error('Business activity checkpoint has an invalid time');
  const pending=new Map<string,{sequence:number;tool:string|null;checkpointAtMs:number}>();
  let event:Event|undefined;
  const hash=(operation:string)=>createHash('sha256').update(operation).digest('hex').slice(0,32);
  const activity=createRepairActivityMonitor({now,initialCheckpointAt:Math.max(startedAt,lastCheckpoint),
    timeoutMs:input.timeoutMs??20*60*1000,longToolTimeoutMs:input.timeoutMs??20*60*1000,
    known:operation=>known.has(hash(operation)),checkpoint:operation=>{
      const key=hash(operation);if(known.has(key))return false;
      known.add(key);pending.set(key,{sequence:event!.sequence,tool:event?.tool??null,checkpointAtMs:now()});return true;
    }});
  return {
    begin:()=>activity.begin(),intervalMs,failureKind:'activity-stalled' as const,
    observe(observation:Event){event=observation;try{activity.observe(observation);}finally{event=undefined;}},
    failure:()=>activity.failure()?.replace(/^Admin investigation stalled:/,'Business execution stalled:')??null,
    async persist(){
      if(!pending.size)return;
      db.transaction(()=>{
        const current=db.prepare('SELECT execution_id,run_id,task_id,agent,pipeline,status,work_item_id,dispatch_generation_key FROM execution_attempts WHERE execution_id=?')
          .get(source.execution_id) as Source|undefined;
        // A role terminal command persists its structured result in the same
        // transaction that changes this execution from running to
        // output_received. The CLI's completed-tool telemetry is necessarily
        // observed afterwards, so that transition is still the same source —
        // not a superseding writer. Keep every immutable identity fence and
        // reject cancelled/retried/later lifecycle states.
        if(!current||!['running','output_received'].includes(current.status)||current.run_id!==source.run_id||current.task_id!==source.task_id
          ||current.agent!==source.agent||current.pipeline!==source.pipeline||current.work_item_id!==source.work_item_id
          ||current.dispatch_generation_key!==source.dispatch_generation_key)throw new Error('Business activity source changed before persistence');
        const insert=db.prepare(`INSERT INTO execution_receipts(receipt_id,execution_id,kind,receipt_key,payload_json)
          VALUES(?,?,'activity_checkpoint',?,?) ON CONFLICT(execution_id,kind,receipt_key) DO NOTHING`);
        for(const [operationHash,checkpoint] of pending)insert.run(randomUUID(),source.execution_id,operationHash,
          JSON.stringify({policyVersion:1,operationHash,sequence:checkpoint.sequence,tool:checkpoint.tool,checkpointAtMs:checkpoint.checkpointAtMs,
            workItemId:source.work_item_id,dispatchGenerationKey:source.dispatch_generation_key,acceptanceVerified:false}));
      }).immediate();pending.clear();
    },
  };
}
