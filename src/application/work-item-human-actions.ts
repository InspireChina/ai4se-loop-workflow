import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { hash } from '../infrastructure/database';
import type { WorkflowItemRow } from './work-items';
import { transitionWorkItemInDb, reconcileNativeWorkItemExecutionsInDb } from './work-item-transitions';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';
import { cancelInterventionAttemptInDb } from './interventions';
import { nativeFinalDocumentInDb } from './work-item-artifacts';

type Db = Database.Database;
function native(db: Db, taskId: string) {
  return Boolean(db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(taskId));
}

/** Human submission is scoped by Intervention → Work Item, never by a task
 * cursor/current Agent or a Lane's display state. Answers alone do not resume. */
export function submitNativeHumanInputsInDb(db: Db, input: {
  taskId: string; kind: 'questions' | 'runtime'; lane?: 'analysis' | 'delivery';
}) {
  if (!native(db, input.taskId)) return false;
  return db.transaction(() => {
    const table = input.kind === 'questions' ? 'questions' : 'runtime_input_requests';
    const idColumn = input.kind === 'questions' ? 'question_id' : 'request_id';
    const targets = db.prepare(`SELECT DISTINCT item.* FROM workflow_items item
      JOIN interventions intervention ON intervention.item_id = item.item_id AND intervention.task_id = item.task_id
      JOIN ${table} request ON request.intervention_id = intervention.intervention_id AND request.task_id = item.task_id
      WHERE item.task_id = ? AND item.origin = 'native' AND item.status = 'waiting'
        AND request.status IN ('pending', 'answered') AND (? IS NULL OR item.lane = ?)
      ORDER BY item.item_id`).all(input.taskId, input.lane || null, input.lane || null) as WorkflowItemRow[];
    if (!targets.length) {
      // A duplicate click after successful submission is harmless, but it may
      // not manufacture a resume when no input-backed transition exists.
      const submitted = db.prepare(`SELECT 1 FROM workflow_item_events event JOIN workflow_items item ON item.item_id = event.item_id
        WHERE item.task_id = ? AND event.event_type = 'resume' AND event.event_key LIKE ?
          AND item.status IN ('ready', 'running') AND (? IS NULL OR item.lane = ?) LIMIT 1`)
        .get(input.taskId, `human-inputs:${input.kind}:%`, input.lane || null, input.lane || null);
      if (submitted) return true;
      throw new Error(input.kind === 'questions' ? '当前工作项没有可提交的澄清回答' : '当前工作项没有可提交的运行信息回答');
    }
    for (const item of targets) {
      const requests = db.prepare(`SELECT request.${idColumn} AS id, request.status, request.answer, intervention.intervention_id,
          intervention.status AS intervention_status FROM ${table} request
        JOIN interventions intervention ON intervention.intervention_id = request.intervention_id
        WHERE request.task_id = ? AND intervention.task_id = request.task_id AND intervention.item_id = ?
          AND request.status IN ('pending', 'answered') ORDER BY request.${idColumn}`)
        .all(input.taskId, item.item_id) as { id: string; status: string; answer: string | null; intervention_id: string; intervention_status: string }[];
      if (requests.some((request) => request.status === 'pending')) {
        throw new Error(input.kind === 'questions' ? '仍有未回答的澄清问题，不能继续推进' : '仍有未回答的运行信息，不能继续执行');
      }
      if (requests.some((request) => request.intervention_status !== 'resolved')) throw new Error('输入介入尚未解决，不能恢复工作项');
      transitionWorkItemInDb(db, { itemId: item.item_id, action: 'resume', eventKey: `human-inputs:${input.kind}:${hash(JSON.stringify(requests))}`,
        actor: 'human', authority: 'human', reason: input.kind === 'questions' ? '人工澄清回答已提交' : '人工运行信息回答已提交',
        context: { kind: input.kind, inputs: requests } });
    }
    db.prepare(`UPDATE tasks SET next_step = ?, last_actor = 'human', updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`)
      .run(input.kind === 'questions' ? '人工澄清回答已提交，工作项恢复推进' : '人工运行信息已提交，工作项恢复推进', input.taskId);
    projectNativeWorkflowDisplayInDb(db, input.taskId);
    return true;
  })();
}

export function acknowledgeNativeClosureInDb(db: Db, input: { taskId: string; reviewRevision: number; actor: 'human' }) {
  if (!native(db, input.taskId)) return false;
  return db.transaction(() => {
    const task = db.prepare('SELECT review_document_id, review_revision, is_paused FROM tasks WHERE task_id = ?')
      .get(input.taskId) as { review_document_id: string | null; review_revision: number; is_paused: number };
    if (task.review_revision !== input.reviewRevision || !task.review_document_id
      || !db.prepare('SELECT 1 FROM documents WHERE document_id = ? AND task_id = ?').get(task.review_document_id, input.taskId)) {
      throw new Error('最终文档版本已变化，请阅读最新版本');
    }
    const acknowledged = db.prepare('SELECT review_document_id FROM closure_acknowledgements WHERE task_id = ? AND review_revision = ?')
      .get(input.taskId, input.reviewRevision) as { review_document_id: string } | undefined;
    if (acknowledged?.review_document_id === task.review_document_id) return true;
    if (task.is_paused) throw new Error('已暂停的需求不能关闭');
    const closure = db.prepare(`SELECT * FROM workflow_items WHERE task_id = ? AND kind = 'closure'
      AND origin = 'native' AND status = 'waiting'`).get(input.taskId) as WorkflowItemRow | undefined;
    if (!closure) throw new Error('需求当前没有等待最终文档阅读的工作项');
    if (!nativeFinalDocumentInDb(db, input.taskId)) throw new Error('最终文档缺少当前工作项的可信产物来源，请阅读最新版本');
    if (db.prepare(`SELECT 1 FROM workflow_items WHERE task_id = ? AND origin = 'native' AND item_id != ?
      AND status NOT IN ('completed', 'superseded', 'cancelled') LIMIT 1`).get(input.taskId, closure.item_id)) {
      throw new Error('仍有未完成的工作项，不能关闭需求');
    }
    if (db.prepare(`SELECT 1 FROM interventions WHERE task_id = ? AND status IN ('pending', 'running', 'awaiting_human') LIMIT 1`).get(input.taskId)) {
      throw new Error('仍有未解决的介入，不能关闭需求');
    }
    if (db.prepare("SELECT 1 FROM document_comments WHERE task_id = ? AND feedback_status != 'resolved' LIMIT 1").get(input.taskId)) {
      throw new Error('当前仍有反馈尚未通过闭环验证');
    }
    const artifactName = closure.work_key === 'ba:closure' ? '需求规格说明书' : '结卡报告';
    transitionWorkItemInDb(db, { itemId: closure.item_id, action: 'complete', eventKey: `closure:${input.reviewRevision}`,
      actor: input.actor, authority: 'human', reason: `已阅读并确认${artifactName} v${input.reviewRevision}`,
      context: { reviewDocumentId: task.review_document_id, reviewRevision: input.reviewRevision } });
    db.prepare(`INSERT INTO closure_acknowledgements(acknowledgement_id, task_id, review_document_id, review_revision, acknowledged_by)
      VALUES(?, ?, ?, ?, ?)`).run(randomUUID(), input.taskId, task.review_document_id, input.reviewRevision, input.actor);
    db.prepare(`UPDATE tasks SET next_step = ?, last_actor = 'human',
      updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`).run(`${artifactName}已阅读，需求已关闭`, input.taskId);
    projectNativeWorkflowDisplayInDb(db, input.taskId);
    db.prepare(`INSERT INTO task_events(event_id, task_id, actor, event_type, summary) VALUES(?, ?, 'human', 'ClosureAcknowledged', ?)`)
      .run(randomUUID(), input.taskId, `已阅读${artifactName} v${input.reviewRevision} 并关闭需求。`);
    return true;
  })();
}

export function releaseNativeWorkItemBlockInDb(db: Db, input: { taskId: string; lane?: 'analysis' | 'delivery' }) {
  if (!native(db, input.taskId)) return false;
  return db.transaction(() => {
    reconcileNativeWorkItemExecutionsInDb(db, input.taskId);
    const blocked = db.prepare(`SELECT item.*, execution.execution_id, execution.last_error FROM workflow_items item
      JOIN execution_attempts execution ON execution.work_item_id = item.item_id AND execution.task_id = item.task_id
      WHERE item.task_id = ? AND item.origin = 'native' AND item.status = 'waiting' AND execution.agent = item.agent
        AND execution.status = 'system_blocked' AND (? IS NULL OR item.lane = ?)
        AND execution.execution_id = (SELECT latest.execution_id FROM execution_attempts latest
          WHERE latest.work_item_id = item.item_id AND latest.agent = item.agent AND latest.pipeline != 'intervention'
          ORDER BY latest.work_item_attempt DESC, latest.rowid DESC LIMIT 1)
      ORDER BY item.item_id`).all(input.taskId, input.lane || null, input.lane || null) as
      (WorkflowItemRow & { execution_id: string; last_error: string | null })[];
    if (!blocked.length) {
      if (db.prepare(`SELECT 1 FROM workflow_item_events event JOIN workflow_items item ON item.item_id = event.item_id
        WHERE item.task_id = ? AND event.event_key LIKE 'human-unblock:%' AND item.status IN ('ready', 'running')
          AND (? IS NULL OR item.lane = ?) LIMIT 1`).get(input.taskId, input.lane || null, input.lane || null)) return true;
      throw new Error('当前没有可恢复的原生系统阻塞工作项');
    }
    for (const item of blocked) {
      const interventions = db.prepare(`SELECT intervention_id, dedupe_key, source_execution_id, authority FROM interventions
        WHERE item_id = ? AND task_id = ? AND status IN ('pending', 'running', 'awaiting_human')`)
        .all(item.item_id, input.taskId) as { intervention_id: string; dedupe_key: string; source_execution_id: string | null; authority: string }[];
      // Explicit human retry may take over the recovery of THIS failed source,
      // never an unrelated decision, runtime request or arbitration obligation.
      if (interventions.some(intervention => intervention.dedupe_key !== `native:execution-failure:${item.execution_id}`
        || intervention.source_execution_id !== item.execution_id || intervention.authority !== 'arbitration')) {
        throw new Error('决策、运行信息或仲裁介入必须先解决，不能用系统恢复绕过');
      }
      for (const intervention of interventions) {
        const reason = '人工接管失败恢复，显式重置原工作项重试额度；原失败证据保留';
        cancelInterventionAttemptInDb(db, intervention.intervention_id, reason);
        db.prepare(`UPDATE interventions SET status = 'resolved', resolution = ?, resolved_by = 'human',
          current_execution_id = NULL, active_session_id = NULL, command_token_hash = NULL, status_viewed_session_id = NULL,
          resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE intervention_id = ?`)
          .run(reason, intervention.intervention_id);
        db.prepare(`INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
          VALUES(?, ?, 'human', 'InterventionResolved', ?)`).run(randomUUID(), input.taskId,
            `${reason}；介入 ${intervention.intervention_id}，失败执行 ${item.execution_id}`);
      }
      transitionWorkItemInDb(db, { itemId: item.item_id, action: 'resume', eventKey: `human-unblock:${item.execution_id}`,
        actor: 'human', authority: 'human', reason: '人工解除系统阻塞，重置当前工作项重试额度', resetRetryBudget: true,
        context: { failureExecutionId: item.execution_id, failureReason: item.last_error } });
    }
    projectNativeWorkflowDisplayInDb(db, input.taskId);
    return true;
  })();
}
