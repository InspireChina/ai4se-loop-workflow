import type Database from 'better-sqlite3';
import { hash } from '../infrastructure/database';
import { restoreExecutionDelegationInDb } from './execution-delegation';
import type { ExecutionAttempt } from './executions';

type Db = Database.Database;
type DocumentHead = { documentId: string; reviewRevision: number; contentHash: string };

export function finalDocumentSnapshotInDb(db: Db, taskId: string): DocumentHead | null {
  const row = db.prepare(`SELECT document.document_id, task.review_revision, document.title, document.content, document.format
    FROM tasks task JOIN documents document ON document.document_id = task.review_document_id AND document.task_id = task.task_id
    WHERE task.task_id = ? AND task.review_revision > 0`).get(taskId) as
    { document_id: string; review_revision: number; title: string; content: string; format: string } | undefined;
  return row ? { documentId: row.document_id, reviewRevision: row.review_revision,
    contentHash: hash(JSON.stringify({ title: row.title, content: row.content, format: row.format })) } : null;
}

/** A mutable task head identifies a candidate, never authorizes it. Proof is
 * either the one-time historical adoption snapshot or an artifact publication
 * from an applied result on the current completed publisher Work Item. The
 * execution may still await its final status update after atomic publication. */
export function nativeFinalDocumentInDb(db: Db, taskId: string): DocumentHead | null {
  const head = finalDocumentSnapshotInDb(db, taskId);
  if (!head) return null;
  const adopted = db.prepare(`SELECT event.payload_json FROM workflow_item_events event JOIN workflow_items item ON item.item_id = event.item_id
    WHERE item.task_id = ? AND item.origin = 'native' AND item.kind = 'closure' AND item.status IN ('waiting','completed')
      AND event.event_key = 'native:adopt' AND event.authority = 'system'`).all(taskId) as { payload_json: string }[];
  for (const event of adopted) {
    try {
      const snapshot = JSON.parse(event.payload_json).finalDocument as DocumentHead | undefined;
      if (snapshot?.documentId === head.documentId && snapshot.reviewRevision === head.reviewRevision
        && snapshot.contentHash === head.contentHash) return head;
    } catch { /* Damaged evidence must not authorize a document. */ }
  }
  const publishers = db.prepare(`SELECT execution.*, item.revision AS publisher_revision, receipt.payload_json AS artifact_json
    FROM workflow_items item JOIN execution_attempts execution ON execution.work_item_id = item.item_id AND execution.task_id = item.task_id
    JOIN execution_receipts receipt ON receipt.execution_id = execution.execution_id
    WHERE item.task_id = ? AND item.origin = 'native' AND item.status = 'completed'
      AND execution.status IN ('output_received','verifying','applying','applied')
      AND item.agent = execution.agent AND (item.pipeline = execution.pipeline OR execution.pipeline = 'resume')
      AND ((item.agent = 'review-agent' AND (item.work_key = 'delivery:review' OR item.pipeline = 'feedback-report'))
        OR (item.agent = 'spec-review-agent' AND item.work_key = 'ba:review'))
      AND receipt.kind = 'work_item_artifact' AND receipt.receipt_key IN ('review_report','business_analysis_specification')`)
    .all(taskId) as (ExecutionAttempt & { publisher_revision: number; artifact_json: string })[];
  for (const source of publishers) {
    try {
      const proof = JSON.parse(source.artifact_json) as DocumentHead & { itemId: string; revision: number; resultId: string };
      const frozen = restoreExecutionDelegationInDb(db, source);
      if (proof.documentId !== head.documentId || proof.reviewRevision !== head.reviewRevision
        || proof.itemId !== source.work_item_id || proof.revision !== source.publisher_revision
        || frozen.reviewRevision + 1 !== head.reviewRevision) continue;
      const result = db.prepare(`SELECT result.result_json, document.title, document.content, document.format FROM agent_results result
        JOIN documents document ON document.document_id = ? AND document.task_id = result.task_id
        WHERE result.result_id = ? AND result.execution_id = ? AND result.task_id = ? AND result.application_status = 'applied'`)
        .get(head.documentId, proof.resultId, source.execution_id, taskId) as
        { result_json: string; title: string; content: string; format: string } | undefined;
      if (!result) continue;
      const submitted = JSON.parse(result.result_json);
      if (submitted.outcome !== 'completed' || (source.agent === 'review-agent'
        ? submitted.verdict !== 'report_ready' : submitted.businessAnalysis?.disposition !== 'approved')) continue;
      // Earlier native Review receipts had no content digest. Validate the
      // exact saved artifact against the applied source result, not task fields.
      if (result.format === 'markdown' && submitted.artifact?.title === result.title
        && submitted.artifact.content === result.content && (!proof.contentHash || proof.contentHash === head.contentHash)) return head;
    } catch { /* Invalid source snapshots/receipts are evidence, not authority. */ }
  }
  return null;
}
