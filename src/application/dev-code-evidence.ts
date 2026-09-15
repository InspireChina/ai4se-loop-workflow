import type Database from 'better-sqlite3';
import { databaseConnection } from '../infrastructure/database';
import { readGitCommitEvidence, type GitCommitEvidence } from '../infrastructure/git-commit-evidence';
import { resourceClaimInDb } from './resource-claims';
import { workflowEndedInDb } from './work-item-controls';

function sourceInDb(db: Database.Database, executionId: string) {
  const source = db.prepare(`SELECT execution.task_id, execution.base_commit, execution.work_item_id,
    task.work_dir, task.is_paused, task.workflow_engine, execution.story_index
    FROM execution_attempts execution JOIN tasks task ON task.task_id = execution.task_id
    WHERE execution.execution_id = ? AND execution.agent = 'dev-agent' AND execution.pipeline = 'dev'
      AND execution.status IN ('output_received', 'verifying', 'applying')`).get(executionId) as
    { task_id: string; base_commit: string; work_item_id: string | null; work_dir: string;
      is_paused: number; workflow_engine: string; story_index: number | null } | undefined;
  if (!source || source.is_paused || workflowEndedInDb(db, source.task_id)) return undefined;
  const baseline = db.prepare(`SELECT payload_json FROM execution_receipts
    WHERE execution_id = ? AND kind = 'code_baseline' AND receipt_key = 'execution-start'`)
    .get(executionId) as { payload_json: string } | undefined;
  if (!baseline) return undefined;
  const snapshot = JSON.parse(baseline.payload_json) as { head: string; clean: boolean; readable: boolean };
  if (snapshot.head !== source.base_commit || snapshot.clean !== true || snapshot.readable !== true) return undefined;
  const claim = resourceClaimInDb(db, 'code:workspace', source.task_id);
  if (!claim || claim.owner_task_id !== source.task_id || claim.owner_execution_id !== executionId
    || claim.owner_story_index !== source.story_index) return undefined;
  if (source.workflow_engine === 'native' && !db.prepare(`SELECT 1 FROM workflow_items item
    WHERE item.item_id = ? AND item.task_id = ? AND item.origin = 'native' AND item.status = 'running'
      AND item.agent = 'dev-agent' AND EXISTS (SELECT 1 FROM execution_attempts execution
        WHERE execution.execution_id = ? AND execution.work_item_id = item.item_id
          AND item.dispatch_epoch = json_extract(execution.input_json, '$.delegation.workItemEpoch')
          AND NOT EXISTS (SELECT 1 FROM execution_attempts newer WHERE newer.work_item_id = item.item_id
            AND newer.work_item_attempt > execution.work_item_attempt))`).get(source.work_item_id, source.task_id, executionId)) return undefined;
  return source;
}

export async function collectDevCodeEvidence(executionId: string,
  readEvidence: typeof readGitCommitEvidence = readGitCommitEvidence): Promise<GitCommitEvidence> {
  const db = await databaseConnection();
  const source = sourceInDb(db, executionId);
  if (!source) return { kind: 'unavailable', reason: '缺少干净的启动基线、来源执行已失效或不再持有自己的代码槽' };
  const evidence = await readEvidence(source.work_dir, source.base_commit);
  const current = sourceInDb(db, executionId);
  if (!current || current.base_commit !== source.base_commit || current.work_dir !== source.work_dir) {
    return { kind: 'unavailable', reason: '采集期间来源执行、基线或代码槽已失效' };
  }
  return evidence;
}
