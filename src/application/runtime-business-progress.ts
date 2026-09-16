import type Database from 'better-sqlite3';
import type {RuntimeCliProcess} from '../domain/runtime-cli';
import type {RuntimeArtifact} from '../domain/runtime-update';
import {runtimeRepairHandoffSchema,type RuntimeRepairHandoff} from '../domain/runtime-repair-followup';
import {runtimeBusinessBaselineSchema,runtimeBusinessProgressCandidateSchema,
  type RuntimeBusinessBaseline,type RuntimeBusinessProgressCandidate} from '../domain/runtime-business-progress';
import {runtimeBusinessCohortChangeSchema,runtimeBusinessCohortInvalidated,type RuntimeBusinessCohortChange} from '../domain/runtime-business-progress';

function assertReadOnly(db:Database.Database){
  if(!db.readonly)throw new Error('运行修复业务证据只能从只读连接读取');
}

/** A later rewind is new authority, never permission to reuse old verification.
 * Paused/deleted/cancelled demands remain user control, not repair failures.
 * One already-proven ordinary advance per demand still suffices. */
export function findRuntimeBusinessCohortChangesInDb(db:Database.Database,input:{
  baseline:RuntimeBusinessBaseline;progressTaskIds:string[];assertCurrent:()=>void;
}):RuntimeBusinessCohortChange[] {
  assertReadOnly(db);input.assertCurrent();const baseline=runtimeBusinessBaselineSchema.parse(input.baseline);
  return db.transaction(()=>{
    input.assertCurrent();
    const columns=db.prepare('PRAGMA table_info(workflow_items)').all() as {name:string}[];
    const field=(name:string,alias:string)=>`${columns.some(column=>column.name===name)?`item.${name}`:'NULL'} AS ${alias}`;
    const available=db.prepare(`SELECT 1 FROM tasks task JOIN projects project ON project.project_id=task.project_id
      WHERE task.task_id=? AND task.workflow_engine='native' AND task.is_paused=0 AND project.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM workflow_item_events event JOIN workflow_items controlled ON controlled.item_id=event.item_id
        WHERE controlled.task_id=task.task_id AND controlled.origin='native'
        AND event.event_key IN ('task:cancelled','native:adopt:task-cancelled') AND event.authority IN ('human','system'))`);
    const query=db.prepare(`SELECT item.item_id AS itemId,item.revision,item.dispatch_epoch AS dispatchEpoch,item.status,item.origin,
      ${field('work_key','workKey')},${field('kind','kind')},${field('story_index','storyIndex')},${field('superseded_by_item_id','successorId')}
      FROM workflow_items item WHERE item.task_id=? AND item.item_id=?`);
    const changes:RuntimeBusinessCohortChange[]=[];
    for(const task of baseline.tasks){
      if(input.progressTaskIds.includes(task.taskId)||!available.get(task.taskId))continue;
      for(const original of task.items){
        const current=runtimeBusinessCohortChangeSchema.shape.current.parse(query.get(task.taskId,original.itemId)??null);
        if(runtimeBusinessCohortInvalidated(original,current))
          changes.push(runtimeBusinessCohortChangeSchema.parse({taskId:task.taskId,originalItemId:original.itemId,
            originalRevision:original.revision,current}));
      }
    }
    input.assertCurrent();return changes;
  })();
}

/** The caller proves update silence AND physical exit before and after this
 * consistent read. Never capture from a still-writing old host or silently
 * treat a corrupt/missing schema as an empty original workload. */
export function captureRuntimeBusinessBaselineInDb(db:Database.Database,input:{
  caseId:string;verificationAttemptId:string;updateId:string;candidateArtifact:RuntimeArtifact;
  originalBoundaryMs:number;originalStartBoundaryMs?:number;assertQuiescent:()=>void;
}):RuntimeBusinessBaseline {
  assertReadOnly(db);input.assertQuiescent();
  return db.transaction(()=>{
    input.assertQuiescent();
    const {assertQuiescent:_assertQuiescent,...binding}=input;
    const identity=runtimeBusinessBaselineSchema.parse({...binding,schemaVersion:1,tasks:[]});
    const columns=db.prepare('PRAGMA table_info(workflow_items)').all() as {name:string}[];
    const hasLineage=['work_key','kind','story_index','superseded_by_item_id'].every(name=>columns.some(column=>column.name===name));
    // Read all timestamps first: invalid timestamps must not silently remove
    // an original obligation from the frozen coverage set.
    const rows=db.prepare(`SELECT item.item_id AS itemId,item.task_id AS taskId,item.revision,item.dispatch_epoch AS dispatchEpoch,
      item.status,item.completed_at AS completedAt,julianday(item.created_at) AS createdDay,
      julianday(item.completed_at) AS completedDay,julianday(item.updated_at) AS updatedDay,
      ${hasLineage?'item.work_key AS workKey,item.kind,item.story_index AS storyIndex,item.superseded_by_item_id AS successorId':
        'NULL AS workKey,NULL AS kind,NULL AS storyIndex,NULL AS successorId'}
      FROM workflow_items item JOIN tasks task ON task.task_id=item.task_id
      WHERE item.origin='native' AND task.workflow_engine='native'
      ORDER BY item.task_id,item.item_id`).all() as Array<{
        itemId:string;taskId:string;revision:number;dispatchEpoch:number;status:string;completedAt:string|null;
        createdDay:number|null;completedDay:number|null;updatedDay:number|null;
        workKey:string|null;kind:string|null;storyIndex:number|null;successorId:string|null}>;
    const boundaryDay=2440587.5+identity.originalBoundaryMs/86400000;
    const startDay=2440587.5+(identity.originalStartBoundaryMs??identity.originalBoundaryMs)/86400000;
    const tasks=new Map<string,RuntimeBusinessBaseline['tasks'][number]>();
    const executions=db.prepare('SELECT execution_id AS executionId FROM execution_attempts WHERE task_id=? AND work_item_id=? ORDER BY execution_id');
    const byId=new Map(rows.map(row=>[row.itemId,row]));
    for(const row of rows){
      if(row.createdDay===null||row.updatedDay===null||row.completedAt!==null&&row.completedDay===null)
        throw new Error('原业务工作项时间无效，无法冻结完整基线');
    }
    for(const row of rows){
      if(row.createdDay! > boundaryDay||['superseded','cancelled'].includes(row.status)&&row.updatedDay! <= startDay
        ||row.status==='completed'&&row.completedDay!==null&&row.completedDay<=startDay)continue;
      // A cancellation/supersession AFTER the original fault cannot erase
      // that affected demand from the recovery cohort. Its current terminal
      // state still cannot pass the ordinary progress observer below.
      // A completion without its timestamp is not a trustworthy historical
      // completion and must not be omitted from the affected originals.
      // Resolve only the persisted supersession chain present while writers
      // are stopped. Never guess MAX(revision), jump to another work key, or
      // silently erase a cancelled original. Later rewinds require fresh
      // independent verification and a new immutable baseline.
      let head=row;const chain:typeof rows=[];const seen=new Set([row.itemId]);
      while(hasLineage&&head.status==='superseded'&&head.successorId){
        const next=byId.get(head.successorId);
        if(!next||seen.has(next.itemId)||next.taskId!==row.taskId||next.workKey!==row.workKey
          ||next.kind!==row.kind||next.storyIndex!==row.storyIndex||next.revision<=head.revision)
          throw new Error('原工作项回退链缺失、循环或跨越契约身份');
        seen.add(next.itemId);chain.push(head);head=next;
      }
      let task=tasks.get(row.taskId);if(!task){task={taskId:row.taskId,items:[]};tasks.set(row.taskId,task);}
      const previousExecutionIds=[...new Set([...chain,head].flatMap(item=>
        (executions.all(row.taskId,item.itemId) as {executionId:string}[]).map(row=>row.executionId)))].sort();
      const existing=task.items.find(item=>item.itemId===head.itemId);
      if(existing){
        existing.previousExecutionIds=[...new Set([...existing.previousExecutionIds,...previousExecutionIds])].sort();
        if(chain.length>(existing.predecessors?.length??0))existing.predecessors=chain.map(item=>({itemId:item.itemId,revision:item.revision}));
        continue;
      }
      task.items.push({itemId:head.itemId,revision:head.revision,dispatchEpoch:head.dispatchEpoch,previousExecutionIds,
        ...(hasLineage?{workKey:head.workKey!,kind:head.kind!,storyIndex:head.storyIndex}:{}),
        ...(chain.length?{predecessors:chain.map(item=>({itemId:item.itemId,revision:item.revision}))}:{}),
      });
    }
    const result=runtimeBusinessBaselineSchema.parse({...identity,tasks:[...tasks.values()]});
    input.assertQuiescent();return result;
  })();
}

/** One real ordinary advance per original demand, not every future scaffolded
 * stage or a human Closure acknowledgement. Returns candidates, never closes
 * a Case, completes work or interprets a ready/heartbeat flag as recovery. */
export function findRuntimeBusinessProgressCandidatesInDb(db:Database.Database,input:{
  baseline:RuntimeBusinessBaseline;handoffs:RuntimeRepairHandoff[];clis:RuntimeCliProcess[];assertCurrent:()=>void;
}):RuntimeBusinessProgressCandidate[] {
  assertReadOnly(db);input.assertCurrent();
  const baseline=runtimeBusinessBaselineSchema.parse(input.baseline);
  const handoffs=input.handoffs.map(handoff=>runtimeRepairHandoffSchema.parse(handoff));
  if(handoffs.some(handoff=>handoff.caseId!==baseline.caseId||handoff.verificationAttemptId!==baseline.verificationAttemptId
    ||handoff.updateId!==baseline.updateId||handoff.artifact.artifactId!==baseline.candidateArtifact.artifactId
    ||handoff.artifact.sourceId!==baseline.candidateArtifact.sourceId||handoff.artifact.root!==baseline.candidateArtifact.root
    ||handoff.artifact.version!==baseline.candidateArtifact.version))throw new Error('业务推进来源与已冻结运行修复不一致');
  if(new Set(handoffs.map(row=>row.hostAllocationId)).size!==handoffs.length)throw new Error('业务推进宿主交还来源重复');
  return db.transaction(()=>{
    input.assertCurrent();
    const candidates:RuntimeBusinessProgressCandidate[]=[];
    const hasIdentity=baseline.tasks.some(task=>task.items.some(item=>item.workKey!==undefined||item.kind!==undefined||item.storyIndex!==undefined));
    const query=db.prepare(`SELECT execution.execution_id AS executionId,result.result_id AS resultId,
      event.event_id AS completionEventId,item.item_id AS itemId,item.task_id AS taskId,item.revision AS itemRevision,
      item.dispatch_epoch AS dispatchEpoch
      FROM workflow_items item JOIN tasks task ON task.task_id=item.task_id
      JOIN projects project ON project.project_id=task.project_id
      JOIN execution_attempts execution ON execution.work_item_id=item.item_id AND execution.task_id=item.task_id
      JOIN agent_results result ON result.execution_id=execution.execution_id AND result.task_id=item.task_id
      JOIN workflow_item_events event ON event.item_id=item.item_id AND event.execution_id=execution.execution_id
        AND event.event_key='result:'||result.result_id AND event.event_type='complete' AND event.authority='agent'
      WHERE item.item_id=? AND item.task_id=? AND item.revision=? AND item.dispatch_epoch>=?
        AND item.origin='native' AND task.workflow_engine='native' AND item.status='completed'
        AND item.completion_authority='agent' AND task.is_paused=0 AND project.deleted_at IS NULL
        AND execution.status='applied' AND result.application_status='applied' AND result.effect_outcome='advanced'
        AND json_valid(execution.input_json) AND json_extract(execution.input_json,'$.delegation.workItemEpoch')=item.dispatch_epoch
        AND NOT EXISTS(SELECT 1 FROM execution_processes process WHERE process.execution_id=execution.execution_id AND process.status<>'exited')
        AND NOT EXISTS(SELECT 1 FROM interventions hold WHERE hold.task_id=item.task_id AND (hold.item_id IS NULL OR hold.item_id=item.item_id)
          AND hold.status IN ('pending','running','awaiting_human'))
        AND NOT EXISTS(SELECT 1 FROM workflow_item_events cancellation JOIN workflow_items controlled ON controlled.item_id=cancellation.item_id
          WHERE controlled.task_id=item.task_id AND controlled.origin='native'
            AND cancellation.event_key IN ('task:cancelled','native:adopt:task-cancelled') AND cancellation.authority IN ('human','system'))
        ${hasIdentity?'AND (? IS NULL OR item.work_key=?) AND (? IS NULL OR item.kind=?) AND (?=0 OR item.story_index IS ?)':''}
      ORDER BY result.applied_at,result.result_id`);
    for(const task of baseline.tasks){
      let found:RuntimeBusinessProgressCandidate|undefined;
      for(const item of task.items){
        const rows=query.all(item.itemId,task.taskId,item.revision,item.dispatchEpoch,
          ...(hasIdentity?[item.workKey??null,item.workKey??null,item.kind??null,item.kind??null,
            item.storyIndex===undefined?0:1,item.storyIndex??null]:[])) as Array<{
          executionId:string;resultId:string;completionEventId:string;itemId:string;taskId:string;itemRevision:number;dispatchEpoch:number}>;
        for(const row of rows){
          if(item.previousExecutionIds.includes(row.executionId))continue;
          for(const cli of input.clis){
            const handoff=handoffs.find(host=>host.hostAllocationId===cli.hostAllocationId);
            if(!handoff||cli.executionId!==row.executionId||cli.status!=='exited')continue;
            const parsed=runtimeBusinessProgressCandidateSchema.safeParse({...row,handoff,cli});
            if(parsed.success){found=parsed.data;break;}
          }
          if(found)break;
        }
        if(found)break;
      }
      if(found)candidates.push(found);
    }
    input.assertCurrent();return candidates;
  })();
}
