/** Historical Feedback selector for migration tests only. */
import type Database from 'better-sqlite3';
import type { FeedbackGroup } from '../application/tasks';
import { ensureFeedbackBatchInDb } from '../application/feedback';
import { nativeFeedbackInDb } from '../application/work-item-feedback';
type Db = Database.Database;

export type FeedbackDispatch =
  | {
      kind: 'triage';
      batchId: string;
      commentIds: string[];
      feedbackId: string;
      description: string;
    }
  | {
      kind: 'verify';
      batchId: string;
      groupId: string;
      commentIds: string[];
      feedbackId: string;
      description: string;
    }
  | {
      kind: 'repro';
      batchId: string;
      groupId: string;
      commentIds: string[];
      feedbackId: string;
      resume: boolean;
      description: string;
    }
  | {
      kind: 'split';
      batchId: string;
      groupId: string;
      commentIds: string[];
      feedbackId: string;
      description: string;
    }
  | {
      kind: 'report';
      batchId: string;
      groupId: string;
      commentIds: string[];
      feedbackId: string;
      description: string;
    };

function batchCommentIds(db: Db, batchId: string) {
  return (db.prepare(`
    SELECT comment_id FROM feedback_batch_comments
    WHERE batch_id = ? ORDER BY ordinal, comment_id
  `).all(batchId) as { comment_id: string }[]).map((row) => row.comment_id);
}

function groupCommentIds(db: Db, groupId: string) {
  return (db.prepare(`
    SELECT comment_id FROM feedback_group_comments
    WHERE group_id = ? ORDER BY comment_id
  `).all(groupId) as { comment_id: string }[]).map((row) => row.comment_id);
}

function activeGroups(db: Db, batchId: string) {
  return db.prepare(`
    SELECT * FROM feedback_groups
    WHERE batch_id = ?
    ORDER BY group_order
  `).all(batchId) as FeedbackGroup[];
}

export function nextFeedbackDispatchInDb(db: Db, taskId: string): FeedbackDispatch | undefined {
  if (nativeFeedbackInDb(db, taskId)) return undefined;
  const batch = ensureFeedbackBatchInDb(db, taskId);
  if (!batch) return undefined;
  const comments = batchCommentIds(db, batch.batch_id);
  if (!comments.length) return undefined;
  if (batch.status === 'triaging') {
    return {
      kind: 'triage',
      batchId: batch.batch_id,
      commentIds: comments,
      feedbackId: comments[0],
      description: `批量判断 ${comments.length} 条反馈，并创建必要的追加交付单元`,
    };
  }
  if (batch.status === 'waiting_for_answers') {
    const task = db.prepare('SELECT run_state, resume_pending FROM tasks WHERE task_id = ?').get(taskId) as { run_state: string; resume_pending: number } | undefined;
    if (task?.run_state === 'runnable' && task.resume_pending) {
      const waitingRepro = activeGroups(db, batch.batch_id).find((group) => group.status === 'waiting_for_repro');
      if (waitingRepro) {
        const groupComments = groupCommentIds(db, waitingRepro.group_id);
        return {
          kind: 'repro',
          batchId: batch.batch_id,
          groupId: waitingRepro.group_id,
          commentIds: groupComments,
          feedbackId: groupComments[0],
          resume: true,
          description: `读取人工回答并继续复现反馈问题：${waitingRepro.title || waitingRepro.reason}`,
        };
      }
      return {
        kind: 'triage',
        batchId: batch.batch_id,
        commentIds: comments,
        feedbackId: comments[0],
        description: `读取人工回答并重新判断反馈批次 ${batch.batch_id}`,
      };
    }
    return undefined;
  }
  const groups = activeGroups(db, batch.batch_id);
  const repro = groups.find((group) => group.status === 'waiting_for_repro');
  if (repro) {
    const groupComments = groupCommentIds(db, repro.group_id);
    return {
      kind: 'repro',
      batchId: batch.batch_id,
      groupId: repro.group_id,
      commentIds: groupComments,
      feedbackId: groupComments[0],
      resume: false,
      description: `复现反馈问题：${repro.title || repro.reason}`,
    };
  }
  const plan = groups.find((group) => group.status === 'waiting_for_plan');
  if (plan) {
    const groupComments = groupCommentIds(db, plan.group_id);
    return {
      kind: 'split',
      batchId: batch.batch_id,
      groupId: plan.group_id,
      commentIds: groupComments,
      feedbackId: groupComments[0],
      description: `把反馈变化规划为完整的追加交付单元：${plan.title || plan.reason}`,
    };
  }
  const verify = groups.find((group) => group.status === 'ready_for_verification');
  if (verify) {
    const groupComments = groupCommentIds(db, verify.group_id);
    const comment = db.prepare(`
      SELECT comment_id FROM document_comments
      WHERE comment_id IN (${groupComments.map(() => '?').join(', ')})
        AND feedback_status = 'verifying'
      ORDER BY created_at, comment_id LIMIT 1
    `).get(...groupComments) as { comment_id: string } | undefined;
    if (comment) {
      return {
        kind: 'verify',
        batchId: batch.batch_id,
        groupId: verify.group_id,
        commentIds: groupComments,
        feedbackId: comment.comment_id,
        description: `验证反馈是否已经满足：${verify.title || verify.reason}`,
      };
    }
  }
  const report = groups.find((group) => group.work_type === 'report_correction' && group.status === 'executing');
  if (report && batch.status === 'reporting') {
    const groupComments = groupCommentIds(db, report.group_id);
    return {
      kind: 'report',
      batchId: batch.batch_id,
      groupId: report.group_id,
      commentIds: groupComments,
      feedbackId: groupComments[0],
      description: `根据反馈生成新版结卡报告：${report.title || report.reason}`,
    };
  }
  return undefined;
}
