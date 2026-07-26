import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import type { AgentResult } from '../domain/agent-result';
import { assertState, type TaskState } from '../domain/task';
import { databaseConnection } from '../infrastructure/database';
import { markFeedbackReportGeneratedInDb } from './feedback';
import type { DelegationEnvelope } from './tasks';

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
             resume_status, resume_pending, blocked_reason
      FROM tasks WHERE task_id = ?
    `).get(delegation.taskId) as TaskState | undefined;
    if (!task) throw new Error(`需求不存在：${delegation.taskId}`);
    const baselineMatches = task.review_revision === delegation.reviewRevision
      && (task.review_document_id || '') === delegation.reviewDocumentId;
    if (delegation.pipeline === 'review') {
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
    if (delegation.pipeline === 'feedback-report') {
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
      prospective.agile_status === 'ready_to_close'
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
    return 'advanced';
  })();
  if (outcome === 'advanced') refreshPublication(delegation.taskId);
  return outcome;
}
