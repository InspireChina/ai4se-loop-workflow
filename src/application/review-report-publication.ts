import { randomUUID } from 'node:crypto';
import { invalidatePage as revalidatePath } from '../infrastructure/page-invalidation';
import type { AgentResult } from '../domain/agent-result';
import { assertState, type TaskState } from '../domain/task';
import { databaseConnection } from '../infrastructure/database';
import { markFeedbackReportGeneratedInDb } from './feedback';
import type { DelegationEnvelope } from './tasks';
import type { WorkflowItemRow } from './work-items';
import { transitionWorkItemInDb } from './work-item-transitions';
import { feedbackSourceItemInDb } from './work-item-feedback';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';
import { workflowEndedInDb, workflowResultHeldInDb } from './work-item-controls';
import { restoreExecutionDelegationInDb } from './execution-delegation';
import type { ExecutionAttempt } from './executions';
import { finalDocumentSnapshotInDb } from './work-item-artifacts';

type PublicationOutcome = 'advanced' | 'discarded';

function refreshPublication(taskId: string) {
  try {
    revalidatePath('/');
    revalidatePath(`/tasks/${taskId}`);
  } catch {
    // CLI and tests run outside a Next request context.
  }
}

export async function publishReviewReport(input: {
  delegation: DelegationEnvelope;
  result: AgentResult;
  resultId: string;
  executionId?: string;
}): Promise<PublicationOutcome> {
  const { delegation, result } = input;
  if (!result.artifact || result.verdict !== 'report_ready') {
    throw new Error('Review Agent 报告发布缺少 report_ready artifact');
  }
  const artifact = result.artifact;
  const db = await databaseConnection();
  const outcome = db.transaction((): PublicationOutcome => {
    const task = db.prepare(`
      SELECT task_id, agile_status, current_subagent,
             analysis_index, dev_index, test_index, total_stories,
             spec_resolved_index, run_state, closure_status,
             review_revision, review_document_id, closure_acknowledged_at,
             resume_status, resume_pending, blocked_reason, workflow_engine, is_paused
      FROM tasks WHERE task_id = ?
    `).get(delegation.taskId) as (TaskState & { workflow_engine: string; is_paused: number }) | undefined;
    if (!task) throw new Error(`需求不存在：${delegation.taskId}`);
    const baselineMatches = task.review_revision === delegation.reviewRevision
      && (task.review_document_id || '') === delegation.reviewDocumentId;
    const native = task.workflow_engine === 'native';
    let nativeItem: (WorkflowItemRow & { source_status: string }) | undefined;
    if (native) {
      if (!input.executionId) throw new Error('原生报告发布必须关联来源执行');
      nativeItem = db.prepare(`SELECT item.*, execution.status AS source_status FROM execution_attempts execution JOIN workflow_items item ON item.item_id = execution.work_item_id
        WHERE execution.execution_id = ? AND execution.task_id = ? AND execution.agent = 'review-agent'
          AND item.task_id = execution.task_id AND item.origin = 'native' AND item.agent = execution.agent
          AND item.pipeline = ?`).get(input.executionId, delegation.taskId, delegation.pipeline) as (WorkflowItemRow & { source_status: string }) | undefined;
      if (!nativeItem || delegation.workItemId && nativeItem.item_id !== delegation.workItemId) throw new Error('原生报告来源与工作项绑定不一致');
      if (task.is_paused || nativeItem.source_status === 'cancelled' || workflowEndedInDb(db, delegation.taskId)
        || ['superseded', 'cancelled', 'completed'].includes(nativeItem.status) || !baselineMatches) return 'discarded';
      const source = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?')
        .get(input.executionId) as ExecutionAttempt;
      const frozen = restoreExecutionDelegationInDb(db, source);
      if (delegation.reviewRevision !== frozen.reviewRevision || delegation.reviewDocumentId !== frozen.reviewDocumentId
        || delegation.workItemRevision !== undefined && delegation.workItemRevision !== frozen.workItemRevision
        || delegation.workItemEpoch !== undefined && delegation.workItemEpoch !== frozen.workItemEpoch) {
        throw new Error('原生报告发布的产物版本、工作项版本或派发代次与冻结来源不一致');
      }
      if (workflowResultHeldInDb(db, delegation.taskId, input.executionId)) throw new Error('报告来源工作项仍有未解除的依赖或介入门禁，不能发布');
      if (nativeItem.status !== 'running') throw new Error('报告工作项未在运行');
      if (delegation.pipeline === 'feedback-report') {
        if (!delegation.feedbackBatchId || !delegation.feedbackGroupId) throw new Error('反馈报告缺少冻结归属');
        feedbackSourceItemInDb(db, { taskId: delegation.taskId, executionId: input.executionId, pipeline: delegation.pipeline,
          batchId: delegation.feedbackBatchId, groupId: delegation.feedbackGroupId });
      } else if (delegation.pipeline !== 'review' || nativeItem.work_key !== 'delivery:review') {
        throw new Error(`Review Agent 不支持 pipeline=${delegation.pipeline}`);
      }
    } else if (delegation.pipeline === 'review') {
      if (
        task.agile_status !== 'in review'
        || task.current_subagent !== 'review-agent'
        || task.closure_status !== 'none'
        || task.total_stories !== delegation.totalStories
        || !baselineMatches
      ) return 'discarded';
    } else if (delegation.pipeline === 'feedback-report') {
      if (
        task.agile_status !== 'in feedback'
        || task.closure_status !== 'none'
        || !baselineMatches
        || !delegation.feedbackBatchId
        || !delegation.feedbackGroupId
      ) return 'discarded';
    } else {
      throw new Error(`Review Agent 不支持 pipeline=${delegation.pipeline}`);
    }

    const reviewRevision = delegation.reviewRevision + 1;
    const documentId = randomUUID();
    db.prepare(`
      INSERT INTO documents(
        document_id, task_id, story_index, kind, title,
        content, format, source_agent
      ) VALUES(?, ?, NULL, ?, ?, ?, 'markdown', 'review-agent')
    `).run(
      documentId,
      delegation.taskId,
      `review_v${reviewRevision}`,
      artifact.title,
      artifact.content,
    );
    db.prepare(`
      INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
      VALUES(?, ?, 'review-agent', 'DocumentUpserted', ?)
    `).run(
      randomUUID(),
      delegation.taskId,
      `保存文档：${artifact.title}`,
    );

    let prospective: TaskState;
    if (native && nativeItem) {
      // Artifact lineage still uses compare-and-swap. Progress, Agent and Lane
      // fields are display only and cannot authorize or reject publication.
      const updated = db.prepare(`UPDATE tasks SET review_revision = ?, review_document_id = ?, closure_acknowledged_at = NULL,
        next_step = ?, last_actor = 'review-agent', updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND review_revision = ? AND COALESCE(review_document_id, '') = ?`)
        .run(reviewRevision, documentId, `结卡报告 v${reviewRevision} 已生成`, delegation.taskId, delegation.reviewRevision, delegation.reviewDocumentId);
      if (updated.changes !== 1) throw new Error('报告产物版本在发布时发生变化');
      db.prepare(`INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
        VALUES(?, ?, 'work_item_artifact', 'review_report', ?)`)
        .run(randomUUID(), input.executionId, JSON.stringify({ itemId: nativeItem.item_id, revision: nativeItem.revision,
          documentId, reviewRevision, contentHash: finalDocumentSnapshotInDb(db, delegation.taskId)!.contentHash,
          resultId: input.resultId, summary: result.summary }));
      if (delegation.pipeline === 'feedback-report') markFeedbackReportGeneratedInDb(db, {
        taskId: delegation.taskId, batchId: delegation.feedbackBatchId!, groupId: delegation.feedbackGroupId!, executionId: input.executionId });
      // Commit the artifact, completion, wake-up and applied result together.
      // A restart must never leave an applied report on a running Work Item.
      transitionWorkItemInDb(db, { itemId: nativeItem.item_id, action: 'complete', eventKey: `result:${input.resultId}`,
        actor: delegation.agent, authority: 'agent', reason: result.summary, executionId: input.executionId });
      projectNativeWorkflowDisplayInDb(db, delegation.taskId);
      prospective = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(delegation.taskId) as TaskState;
    } else if (delegation.pipeline === 'feedback-report') {
      prospective = {
        ...task,
        current_subagent: 'review-agent',
        closure_status: 'none',
        review_revision: reviewRevision,
        review_document_id: documentId,
        closure_acknowledged_at: null,
        resume_pending: 0,
        blocked_reason: null,
      };
      assertState(prospective);
      const taskUpdate = db.prepare(`
        UPDATE tasks
        SET current_subagent = 'review-agent',
            closure_status = 'none',
            review_revision = ?,
            review_document_id = ?,
            closure_acknowledged_at = NULL,
            resume_pending = 0,
            blocked_reason = NULL,
            next_step = ?,
            last_actor = 'review-agent',
            updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
          AND agile_status = 'in feedback'
          AND closure_status = 'none'
          AND review_revision = ?
          AND COALESCE(review_document_id, '') = ?
      `).run(
        reviewRevision,
        documentId,
        `结卡报告 v${reviewRevision} 已按反馈修订，等待独立验证`,
        delegation.taskId,
        delegation.reviewRevision,
        delegation.reviewDocumentId,
      );
      if (taskUpdate.changes !== 1) throw new Error('报告更正发布时需求状态已变化');
      markFeedbackReportGeneratedInDb(db, {
        taskId: delegation.taskId,
        batchId: delegation.feedbackBatchId!,
        groupId: delegation.feedbackGroupId!,
        executionId: input.executionId,
      });
    } else {
      prospective = {
        ...task,
        agile_status: 'ready_to_close',
        current_subagent: null,
        run_state: 'idle',
        closure_status: 'awaiting_read',
        review_revision: reviewRevision,
        review_document_id: documentId,
        closure_acknowledged_at: null,
        resume_status: null,
        resume_pending: 0,
        blocked_reason: null,
      };
      assertState(prospective);
      const taskUpdate = db.prepare(`
        UPDATE tasks
        SET agile_status = 'ready_to_close',
            current_subagent = NULL,
            run_state = 'idle',
            closure_status = 'awaiting_read',
            review_revision = ?,
            review_document_id = ?,
            closure_acknowledged_at = NULL,
            resume_status = NULL,
            resume_pending = 0,
            blocked_reason = NULL,
            completed_at = NULL,
            next_step = ?,
            last_actor = 'review-agent',
            updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
          AND agile_status = 'in review'
          AND current_subagent = 'review-agent'
          AND closure_status = 'none'
          AND total_stories = ?
          AND review_revision = ?
          AND COALESCE(review_document_id, '') = ?
      `).run(
        reviewRevision,
        documentId,
        `结卡报告 v${reviewRevision} 已生成，等待用户阅读并关闭需求`,
        delegation.taskId,
        delegation.totalStories,
        delegation.reviewRevision,
        delegation.reviewDocumentId,
      );
      if (taskUpdate.changes !== 1) throw new Error('结卡报告发布时需求状态已变化');
    }

    db.prepare(`
      INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
      VALUES(?, ?, 'review-agent', 'TaskUpdated', ?)
    `).run(
      randomUUID(),
      delegation.taskId,
      (native ? delegation.pipeline === 'review' : prospective.agile_status === 'ready_to_close')
        ? `结卡报告 v${reviewRevision} 已生成，等待用户阅读并关闭需求`
        : `结卡报告 v${reviewRevision} 已按反馈修订，等待独立验证`,
    );
    const marked = db.prepare(`
      UPDATE agent_results
      SET application_status = 'applied',
          application_error = NULL,
          effect_outcome = 'advanced',
          applied_at = CURRENT_TIMESTAMP
      WHERE result_id = ? AND application_status = 'pending'
    `).run(input.resultId);
    if (marked.changes !== 1) {
      throw new Error('Review Agent result 已被其他流程处理');
    }
    if (native) projectNativeWorkflowDisplayInDb(db, delegation.taskId);
    return 'advanced';
  })();
  if (outcome === 'advanced') refreshPublication(delegation.taskId);
  return outcome;
}
