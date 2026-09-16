import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { invalidatePage as revalidatePath } from '../infrastructure/page-invalidation';
import { databaseConnection } from '../infrastructure/database';
import type { AgentResult } from '../domain/agent-result';
import type { DeliveryUnitContract } from '../domain/delivery-unit';
import { insertDeliveryUnitContractsInDb } from './delivery-units';
import type { FeedbackBatch, FeedbackGroup, FeedbackVerificationDecision } from './tasks';
import { appendDeliveryWorkItemsInDb } from './work-item-transitions';
import { createFeedbackBatchWorkInDb, createFeedbackGroupWorkInDb, attachFeedbackUnitsInDb,
  nativeFeedbackInDb, feedbackSourceItemInDb, attachFeedbackBatchBarriersInDb, captureFeedbackGroupDescriptorsInDb } from './work-item-feedback';
import { nativeDeliveryReadyInDb } from './work-item-controls';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';

export type FeedbackWorkType = FeedbackGroup['work_type'];

export type FeedbackTriageGroup = {
  groupKey: string;
  commentIds: string[];
  workType: FeedbackWorkType;
  title?: string;
  affectedDeliveryUnits: number[];
  reason: string;
  acceptance: string[];
  response?: string;
};

type Db = Database.Database;

type TaskRow = {
  task_id: string;
  agile_status: string;
  analysis_index: number;
  dev_index: number;
  test_index: number;
  total_stories: number;
};


function refreshTask(taskId: string) {
  try {
    revalidatePath('/');
    revalidatePath(`/tasks/${taskId}`);
  } catch {
    // CLI and tests run outside a Next request context.
  }
}

function addEvent(db: Db, taskId: string, actor: string, eventType: string, summary: string) {
  db.prepare(`
    INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
    VALUES(?, ?, ?, ?, ?)
  `).run(randomUUID(), taskId, actor, eventType, summary);
}

function activeBatchInDb(db: Db, taskId: string) {
  if (nativeFeedbackInDb(db, taskId)) {
    return db.prepare(`SELECT batch.* FROM feedback_batches batch WHERE batch.task_id = ? AND EXISTS (
      SELECT 1 FROM workflow_items item WHERE item.task_id = batch.task_id AND item.kind = 'feedback'
        AND json_extract(item.context_json, '$.feedbackBatchId') = batch.batch_id
        AND item.status NOT IN ('completed', 'superseded', 'cancelled')) ORDER BY batch.batch_number LIMIT 1`).get(taskId) as FeedbackBatch | undefined;
  }
  return db.prepare(`
    SELECT * FROM feedback_batches
    WHERE task_id = ? AND status NOT IN ('completed', 'cancelled')
    ORDER BY batch_number
    LIMIT 1
  `).get(taskId) as FeedbackBatch | undefined;
}

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

function groupDeliveryUnitIndexes(db: Db, groupId: string, taskId: string) {
  return (db.prepare(`
    SELECT story_index FROM feedback_group_delivery_units
    WHERE group_id = ? AND task_id = ? ORDER BY story_index
  `).all(groupId, taskId) as { story_index: number }[]).map((row) => row.story_index);
}

function activeGroups(db: Db, batchId: string) {
  return db.prepare(`
    SELECT * FROM feedback_groups
    WHERE batch_id = ?
    ORDER BY group_order
  `).all(batchId) as FeedbackGroup[];
}

function groupDisplayName(group: Pick<FeedbackGroup, 'title' | 'reason'>) {
  return group.title || group.reason;
}

function updateBatchStatusInDb(db: Db, batchId: string) {
  const batch = db.prepare('SELECT * FROM feedback_batches WHERE batch_id = ?').get(batchId) as FeedbackBatch | undefined;
  if (!batch || batch.status === 'cancelled') return batch;
  const groups = activeGroups(db, batchId);
  let status: FeedbackBatch['status'];
  if (!groups.length) status = batch.status === 'waiting_for_answers' ? 'waiting_for_answers' : 'triaging';
  else if (groups.some((group) => group.status === 'system_blocked')) status = 'system_blocked';
  else if (groups.some((group) => group.work_type === 'report_correction' && group.status === 'executing')
    && !groups.some((group) => group.work_type !== 'report_correction'
      && ['planned', 'waiting_for_repro', 'waiting_for_plan', 'executing'].includes(group.status))) status = 'reporting';
  else if (groups.some((group) => ['planned', 'waiting_for_repro', 'waiting_for_plan', 'executing'].includes(group.status))) status = 'executing';
  else if (groups.some((group) => group.status === 'ready_for_verification')) status = 'verifying';
  else status = 'completed';
  db.prepare(`
    UPDATE feedback_batches
    SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
    WHERE batch_id = ?
  `).run(status, status, batchId);
  return db.prepare('SELECT * FROM feedback_batches WHERE batch_id = ?').get(batchId) as FeedbackBatch;
}

function originType(workType: FeedbackWorkType) {
  if (workType === 'bug') return 'feedback_bug';
  if (workType === 'scope_addition') return 'feedback_scope';
  if (workType === 'technical_change') return 'feedback_technical';
  return 'feedback_behavior';
}

function commentsForNewBatch(db: Db, taskId: string) {
  return db.prepare(`
    SELECT comment_id
    FROM document_comments
    WHERE task_id = ?
      AND status = 'open'
      AND feedback_status IN ('submitted', 'triaged', 'reopened')
      AND NOT EXISTS (
        SELECT 1
        FROM feedback_batch_comments link
        JOIN feedback_batches batch ON batch.batch_id = link.batch_id
        WHERE link.comment_id = document_comments.comment_id
          AND batch.status NOT IN ('completed', 'cancelled')
      )
    ORDER BY
      CASE feedback_status WHEN 'reopened' THEN 0 WHEN 'triaged' THEN 1 ELSE 2 END,
      CASE intent WHEN 'change_request' THEN 0 WHEN 'question' THEN 1 ELSE 2 END,
      created_at,
      comment_id
    LIMIT 100
  `).all(taskId) as { comment_id: string }[];
}

export function ensureFeedbackBatchInDb(db: Db, taskId: string) {
  const current = activeBatchInDb(db, taskId);
  if (current) return current;
  const comments = commentsForNewBatch(db, taskId);
  if (!comments.length) return undefined;
  const batchId = randomUUID();
  db.transaction(() => {
    const batchNumber = (db.prepare(`
      SELECT COALESCE(MAX(batch_number), 0) + 1 AS value
      FROM feedback_batches
      WHERE task_id = ?
    `).get(taskId) as { value: number }).value;
    db.prepare(`
      INSERT INTO feedback_batches(batch_id, task_id, batch_number, status)
      VALUES(?, ?, ?, 'triaging')
    `).run(batchId, taskId, batchNumber);
    const insertLink = db.prepare(`
      INSERT INTO feedback_batch_comments(batch_id, comment_id, ordinal)
      VALUES(?, ?, ?)
    `);
    comments.forEach((comment, index) => insertLink.run(batchId, comment.comment_id, index + 1));
    const placeholders = comments.map(() => '?').join(', ');
    db.prepare(`
      UPDATE document_comments
      SET feedback_status = 'triaged', feedback_batch_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE comment_id IN (${placeholders})
    `).run(batchId, ...comments.map((comment) => comment.comment_id));
    addEvent(db, taskId, 'system', 'FeedbackBatchCreated', `冻结 ${comments.length} 条评论形成反馈批次 ${batchNumber}`);
    createFeedbackBatchWorkInDb(db, taskId, db.prepare('SELECT * FROM feedback_batches WHERE batch_id = ?').get(batchId) as FeedbackBatch);
  })();
  return db.prepare('SELECT * FROM feedback_batches WHERE batch_id = ?').get(batchId) as FeedbackBatch;
}


export async function markFeedbackBatchWaitingForAnswers(taskId: string, batchId: string) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE feedback_batches
    SET status = 'waiting_for_answers', updated_at = CURRENT_TIMESTAMP
    WHERE batch_id = ? AND task_id = ?
  `).run(batchId, taskId);
  refreshTask(taskId);
}

function validateTriageGroups(expectedIds: string[], groups: FeedbackTriageGroup[]) {
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const groupKeys = new Set<string>();
  for (const group of groups) {
    const groupKey = group.groupKey.trim();
    if (!groupKey) throw new Error('Feedback Triage 的 groupKey 不能为空');
    if (groupKeys.has(groupKey)) throw new Error(`Feedback Triage 重复分组标识：${groupKey}`);
    groupKeys.add(groupKey);
    if (!group.commentIds.length) throw new Error(`反馈分组 ${groupKey} 至少需要包含一条评论`);
    for (const commentId of group.commentIds) {
      if (!expected.has(commentId)) throw new Error(`Feedback Triage 返回批次外评论：${commentId}`);
      if (seen.has(commentId)) throw new Error(`Feedback Triage 重复分组评论：${commentId}`);
      seen.add(commentId);
    }
    if (['behavior_change', 'bug', 'scope_addition', 'technical_change', 'report_correction'].includes(group.workType)) {
      if (!group.title?.trim()) throw new Error(`反馈分组 ${group.groupKey} 需要交付单元标题`);
      if (!group.acceptance.length) throw new Error(`反馈分组 ${group.groupKey} 需要可验证的验收条件`);
    }
    if (['reply', 'historical_correction'].includes(group.workType) && !group.response?.trim()) {
      throw new Error(`反馈分组 ${group.groupKey} 需要明确回复或更正说明`);
    }
  }
  const missing = expectedIds.filter((commentId) => !seen.has(commentId));
  if (missing.length) throw new Error(`Feedback Triage 遗漏评论：${missing.join(', ')}`);
}

export async function applyFeedbackTriageGroups(input: {
  taskId: string;
  batchId: string;
  groups: FeedbackTriageGroup[];
  summary: string;
  executionId?: string;
}) {
  const db = await databaseConnection();
  const source = feedbackSourceItemInDb(db, { taskId: input.taskId, batchId: input.batchId,
    executionId: input.executionId, pipeline: 'feedback-triage' });
  const batch = db.prepare(`
    SELECT * FROM feedback_batches WHERE batch_id = ? AND task_id = ?
  `).get(input.batchId, input.taskId) as FeedbackBatch | undefined;
  if (!batch) throw new Error('反馈批次不存在');
  if (!source && batch.status !== 'triaging' && batch.status !== 'waiting_for_answers') {
    if (activeGroups(db, batch.batch_id).length) return;
    throw new Error(`反馈批次当前不能分流：${batch.status}`);
  }
  const expectedIds = source?.scope.feedbackIds || batchCommentIds(db, batch.batch_id);
  validateTriageGroups(expectedIds, input.groups);
  const task = db.prepare('SELECT total_stories FROM tasks WHERE task_id = ?').get(input.taskId) as { total_stories: number };
  for (const group of input.groups) {
    const invalid = group.affectedDeliveryUnits.filter((index) =>
      !Number.isInteger(index) || index < 1 || index > task.total_stories);
    if (invalid.length) throw new Error(`反馈分组引用不存在的交付单元：${invalid.join(', ')}`);
  }

  db.transaction(() => {
    const hasForwardWork = input.groups.some((group) =>
      !['reply', 'historical_correction', 'learning_only'].includes(group.workType));
    if (hasForwardWork) {
      db.prepare(`
        UPDATE tasks
        SET agile_status = 'in feedback', current_subagent = 'feedback-agent',
            run_state = 'runnable', closure_status = 'none',
            closure_acknowledged_at = NULL, blocked_reason = NULL,
            resume_status = NULL, resume_pending = 0, completed_at = NULL,
            next_step = '反馈已冻结并转为向前追加工作',
            last_actor = 'feedback-agent', updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(input.taskId);
    }
    for (const [groupIndex, group] of input.groups.entries()) {
      const groupId = randomUUID();
      const immediate = ['reply', 'historical_correction', 'learning_only'].includes(group.workType);
      const status: FeedbackGroup['status'] = immediate ? 'completed'
        : group.workType === 'bug' ? 'waiting_for_repro'
          : ['behavior_change', 'scope_addition', 'technical_change'].includes(group.workType)
            ? 'waiting_for_plan'
            : 'executing';
      db.prepare(`
        INSERT INTO feedback_groups(
          group_id, batch_id, group_order, group_key, work_type, status, title, reason,
          acceptance_json, affected_story_indexes_json, response_text,
          source_execution_id, completed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP END)
      `).run(
        groupId,
        input.batchId,
        groupIndex + 1,
        group.groupKey,
        group.workType,
        status,
        group.title || null,
        group.reason,
        JSON.stringify(group.acceptance),
        JSON.stringify(group.affectedDeliveryUnits),
        group.response || null,
        input.executionId || null,
        status,
      );
      for (const commentId of group.commentIds) {
        db.prepare(`
          INSERT INTO feedback_group_comments(group_id, comment_id) VALUES(?, ?)
        `).run(groupId, commentId);
        if (immediate) {
          db.prepare(`
            UPDATE document_comments
            SET status = 'resolved', feedback_status = 'resolved',
                disposition = ?, triage_reason = ?, acceptance_json = ?,
                resolution_claim_json = ?, verification_json = ?,
                evolution_status = 'pending', triaged_at = CURRENT_TIMESTAMP,
                resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE comment_id = ?
          `).run(
            group.workType === 'learning_only' ? 'learning_only' : group.workType === 'reply' ? 'reply' : 'no_change',
            group.reason,
            JSON.stringify(group.acceptance),
            JSON.stringify({ response: group.response || group.reason, source: 'feedback-triage' }),
            JSON.stringify({ verdict: 'resolved', reason: group.response || group.reason, evidence: ['Feedback Triage 明确无需代码变更'] }),
            commentId,
          );
        } else {
          db.prepare(`
            UPDATE document_comments
            SET feedback_status = 'in_progress', disposition = 'revise',
                target_stage = NULL, target_agent = NULL, target_story_index = NULL,
                acceptance_json = ?, triage_reason = ?, triaged_at = CURRENT_TIMESTAMP,
                feedback_is_rewind_frontier = 0, feedback_needs_rebase = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE comment_id = ?
          `).run(JSON.stringify(group.acceptance), group.reason, commentId);
        }
      }
      createFeedbackGroupWorkInDb(db, input.taskId, db.prepare('SELECT * FROM feedback_groups WHERE group_id = ?').get(groupId) as FeedbackGroup);
    }
    attachFeedbackBatchBarriersInDb(db, input.taskId, input.batchId);
    captureFeedbackGroupDescriptorsInDb(db, input.taskId, input.batchId);
    db.prepare(`
      UPDATE feedback_batches
      SET source_execution_id = COALESCE(source_execution_id, ?), summary = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE batch_id = ?
    `).run(input.executionId || null, input.summary, input.batchId);
    db.prepare(`
      UPDATE questions
      SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND source_agent = 'feedback-agent' AND status = 'answered'
    `).run(input.taskId);
    db.prepare(`
      UPDATE tasks
      SET resume_pending = 0,
          run_state = CASE WHEN agile_status = 'ready_to_close' THEN 'idle' ELSE run_state END,
          current_subagent = CASE WHEN agile_status = 'ready_to_close' THEN NULL ELSE current_subagent END,
          blocked_reason = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(input.taskId);
    updateBatchStatusInDb(db, input.batchId);
    addEvent(db, input.taskId, 'feedback-agent', 'FeedbackBatchTriaged', `反馈批次 ${batch.batch_number} 已分成 ${input.groups.length} 个前向工作组`);
  })();
  refreshTask(input.taskId);
}

export async function applyFeedbackReproResult(input: {
  taskId: string;
  batchId: string;
  groupId: string;
  result: AgentResult;
  executionId?: string;
}) {
  const db = await databaseConnection();
  const source = feedbackSourceItemInDb(db, { ...input, pipeline: 'feedback-repro' });
  const group = db.prepare(`
    SELECT * FROM feedback_groups WHERE group_id = ? AND batch_id = ?
  `).get(input.groupId, input.batchId) as FeedbackGroup | undefined;
  if (!group || group.work_type !== 'bug' || !source && group.status !== 'waiting_for_repro') throw new Error('反馈 Bug 分组当前不能应用复现结果');
  if (input.result.reproVerdict !== 'reproduced') throw new Error('反馈 Bug 只有成功复现后才能创建修复交付单元');
  db.transaction(() => {
    db.prepare(`
      UPDATE feedback_groups
      SET status = 'waiting_for_plan', source_execution_id = COALESCE(source_execution_id, ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE group_id = ?
    `).run(input.executionId || null, input.groupId);
    db.prepare(`
      UPDATE questions
      SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND source_agent = 'repro-agent' AND status = 'answered'
    `).run(input.taskId);
    updateBatchStatusInDb(db, input.batchId);
    addEvent(db, input.taskId, 'repro-agent', 'FeedbackBugReproduced', `反馈「${groupDisplayName(group)}」已复现，等待规划修复交付单元`);
  })();
  refreshTask(input.taskId);
}

export async function applyFeedbackSplitResult(input: {
  taskId: string;
  batchId: string;
  groupId: string;
  deliveryUnits: DeliveryUnitContract[];
  executionId?: string;
  sourceCommandChainDraftId: string;
}) {
  const db = await databaseConnection();
  const source = feedbackSourceItemInDb(db, { ...input, pipeline: 'feedback-split' });
  const group = db.prepare(`
    SELECT * FROM feedback_groups WHERE group_id = ? AND batch_id = ?
  `).get(input.groupId, input.batchId) as FeedbackGroup | undefined;
  const plannableTypes: FeedbackWorkType[] = ['bug', 'behavior_change', 'scope_addition', 'technical_change'];
  if (!group || !plannableTypes.includes(group.work_type) || !source && group.status !== 'waiting_for_plan') {
    throw new Error('当前反馈工作组不能应用交付规划');
  }
  if (!input.deliveryUnits.length) throw new Error('反馈交付规划必须产生至少一个交付单元');
  db.transaction(() => {
    const affectedDeliveryUnits = JSON.parse(group.affected_story_indexes_json) as number[];
    const inserted = insertDeliveryUnitContractsInDb(db, {
      taskId: input.taskId,
      units: input.deliveryUnits,
      originType: originType(group.work_type),
      originFeedbackBatchId: input.batchId,
      correctsStoryIndexes: affectedDeliveryUnits,
      sourceCommandChainDraftId: input.sourceCommandChainDraftId,
    });
    appendDeliveryWorkItemsInDb(db, { taskId: input.taskId, units: inserted,
      eventKey: `feedback-plan:${input.sourceCommandChainDraftId}`, actor: 'story-splitter-agent', reason: '反馈形成前向交付单元并扩展工作图' });
    for (const unit of inserted) {
      db.prepare(`
        INSERT INTO feedback_group_delivery_units(group_id, task_id, story_index)
        VALUES(?, ?, ?)
      `).run(input.groupId, input.taskId, unit.storyIndex);
      addEvent(
        db,
        input.taskId,
        'story-splitter-agent',
        'FeedbackDeliveryUnitAdded',
        `反馈新增交付单元 ${unit.storyIndex}：${unit.title}（${unit.key}）`,
      );
    }
    attachFeedbackUnitsInDb(db, input.taskId, input.groupId, inserted.map((unit) => unit.storyIndex));
    const lastIndex = inserted[inserted.length - 1].storyIndex;
    db.prepare(`
      UPDATE tasks
      SET total_stories = ?, agile_status = 'in feedback', current_subagent = 'analyst-agent',
          run_state = 'runnable', closure_status = 'none', review_document_id = NULL,
          closure_acknowledged_at = NULL, blocked_reason = NULL, resume_status = NULL,
          resume_pending = 0, completed_at = NULL,
          next_step = ?, last_actor = 'story-splitter-agent', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(
      lastIndex,
      `反馈新增 ${inserted.length} 个交付单元，等待交付分析`,
      input.taskId,
    );
    db.prepare(`
      UPDATE feedback_groups
      SET status = 'executing', source_execution_id = COALESCE(source_execution_id, ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE group_id = ?
    `).run(input.executionId || null, input.groupId);
    updateBatchStatusInDb(db, input.batchId);
    addEvent(db, input.taskId, 'story-splitter-agent', 'FeedbackDeliveryPlanned', `反馈「${groupDisplayName(group)}」规划并追加 ${input.deliveryUnits.length} 个交付单元`);
  })();
  refreshTask(input.taskId);
}

export async function recordFeedbackUnitTestPassed(input: {
  taskId: string;
  storyIndex: number;
  executionId?: string;
}) {
  const db = await databaseConnection();
  const native = nativeFeedbackInDb(db, input.taskId);
  const rows = db.prepare(`
    SELECT DISTINCT feedback_group.*
    FROM feedback_groups feedback_group
    JOIN feedback_group_delivery_units unit ON unit.group_id = feedback_group.group_id
    WHERE unit.task_id = ? AND unit.story_index = ?
      AND (? OR feedback_group.status = 'executing')
  `).all(input.taskId, input.storyIndex, native ? 1 : 0) as FeedbackGroup[];
  if (!rows.length) return;
  db.transaction(() => {
    for (const group of rows) {
      const units = groupDeliveryUnitIndexes(db, group.group_id, input.taskId);
      const task = db.prepare('SELECT test_index FROM tasks WHERE task_id = ?').get(input.taskId) as { test_index: number };
      if (!units.length || (native ? units.some((index) => !db.prepare(`SELECT 1 FROM workflow_items WHERE task_id = ?
          AND work_key = ? AND origin = 'native' AND status = 'completed'`).get(input.taskId, `delivery:test:${index}`))
        : units.some((index) => index > task.test_index))) continue;
      if (native && !db.prepare(`SELECT 1 FROM workflow_items WHERE task_id = ? AND pipeline = 'feedback-verify'
        AND json_extract(context_json, '$.feedbackGroupId') = ? AND status NOT IN ('completed', 'superseded', 'cancelled')`)
        .get(input.taskId, group.group_id)) continue;
      if (group.status === 'ready_for_verification') continue;
      db.prepare(`
        UPDATE feedback_groups
        SET status = 'ready_for_verification', updated_at = CURRENT_TIMESTAMP
        WHERE group_id = ?
      `).run(group.group_id);
      const comments = groupCommentIds(db, group.group_id);
      db.prepare(`
        UPDATE document_comments
        SET feedback_status = 'verifying', updated_at = CURRENT_TIMESTAMP
        WHERE comment_id IN (${comments.map(() => '?').join(', ')})
      `).run(...comments);
      updateBatchStatusInDb(db, group.batch_id);
      addEvent(db, input.taskId, 'system', 'FeedbackVerificationQueued', `反馈「${groupDisplayName(group)}」的追加交付单元已通过测试`);
    }
  })();
  refreshTask(input.taskId);
}

export function markFeedbackReportGeneratedInDb(db: Db, input: {
  taskId: string;
  batchId: string;
  groupId: string;
  executionId?: string;
}) {
  const source = feedbackSourceItemInDb(db, { ...input, pipeline: 'feedback-report' });
  const group = db.prepare(`
    SELECT feedback_group.*
    FROM feedback_groups feedback_group
    JOIN feedback_batches batch
      ON batch.batch_id = feedback_group.batch_id
    WHERE feedback_group.group_id = ?
      AND feedback_group.batch_id = ?
      AND batch.task_id = ?
      AND (? OR batch.status = 'reporting')
  `).get(
    input.groupId,
    input.batchId,
    input.taskId,
    source ? 1 : 0,
  ) as FeedbackGroup | undefined;
  if (
    !group
    || group.work_type !== 'report_correction'
    || !source && group.status !== 'executing'
  ) {
    throw new Error('反馈报告更正分组不存在或已离开执行状态');
  }
  const updated = db.prepare(`
    UPDATE feedback_groups
    SET status = 'ready_for_verification',
        source_execution_id = COALESCE(source_execution_id, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE group_id = ? AND (? OR status = 'executing')
  `).run(input.executionId || null, input.groupId, source ? 1 : 0);
  if (updated.changes !== 1) throw new Error('反馈报告更正分组状态已变化');
  const comments = groupCommentIds(db, input.groupId);
  if (comments.length) {
    db.prepare(`
      UPDATE document_comments
      SET feedback_status = 'verifying', updated_at = CURRENT_TIMESTAMP
      WHERE comment_id IN (${comments.map(() => '?').join(', ')})
    `).run(...comments);
  }
  updateBatchStatusInDb(db, input.batchId);
  addEvent(
    db,
    input.taskId,
    'review-agent',
    'FeedbackReportRegenerated',
    `反馈「${groupDisplayName(group)}」已生成新版结卡报告`,
  );
}

export async function markFeedbackReportGenerated(input: {
  taskId: string;
  batchId: string;
  groupId: string;
  executionId?: string;
}) {
  const db = await databaseConnection();
  db.transaction(() => {
    markFeedbackReportGeneratedInDb(db, input);
  })();
  refreshTask(input.taskId);
}

export function finalizeTaskAfterFeedbackInDb(db: Db, taskId: string, completedBatchId: string) {
  const active = activeBatchInDb(db, taskId);
  if (active) return;
  const unresolved = (db.prepare(`
    SELECT COUNT(*) AS count FROM document_comments
    WHERE task_id = ? AND status = 'open'
  `).get(taskId) as { count: number }).count;
  if (unresolved) return;
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined;
  const native = nativeFeedbackInDb(db, taskId);
  if (!task || !native && task.agile_status !== 'in feedback') return;
  if (native) {
    const unfinishedDelivery = db.prepare(`SELECT 1 FROM workflow_items WHERE task_id = ? AND origin = 'native'
      AND story_index IS NOT NULL AND status NOT IN ('completed', 'superseded', 'cancelled') LIMIT 1`).get(taskId);
    if (unfinishedDelivery) return;
    const ready = nativeDeliveryReadyInDb(db, taskId);
    const awaitingReport = db.prepare(`SELECT 1 FROM workflow_items WHERE task_id = ? AND origin = 'native'
      AND work_key = 'delivery:review' AND status IN ('pending','ready','running','waiting') LIMIT 1`).get(taskId);
    const summary = ready ? '反馈闭环已完成，当前最终文档可供阅读'
      : awaitingReport ? '反馈追加交付已完成，等待工作图推进最终报告'
        : '反馈验证已结束，等待当前工作项、介入或可信最终文档';
    // Graph transitions and artifact publication own scheduling and the head.
    // Never erase a prior artifact or synthesize old cursor/status authority.
    projectNativeWorkflowDisplayInDb(db, taskId);
    db.prepare("UPDATE tasks SET next_step = ?, last_actor = 'system', updated_at = CURRENT_TIMESTAMP WHERE task_id = ?")
      .run(summary, taskId);
    addEvent(db, taskId, 'system', ready ? 'FeedbackReportReady' : awaitingReport ? 'FeedbackDeliveryCompleted' : 'FeedbackVerificationCompleted', summary);
    return;
  }
  if (!(task.total_stories > 0
    && task.analysis_index === task.total_stories
    && task.dev_index === task.total_stories
    && task.test_index === task.total_stories)) return;
  const correctedReport = db.prepare(`
    SELECT 1
    FROM feedback_groups feedback_group
    WHERE feedback_group.batch_id = ?
      AND feedback_group.work_type = 'report_correction'
      AND feedback_group.status = 'completed'
    ORDER BY feedback_group.completed_at DESC
    LIMIT 1
  `).get(completedBatchId);
  if (correctedReport) {
    db.prepare(`
      UPDATE tasks
      SET agile_status = 'ready_to_close', current_subagent = NULL,
          run_state = 'idle', closure_status = 'awaiting_read',
          next_step = '修订后的结卡报告已通过反馈验证，等待用户阅读并关闭需求',
          last_actor = 'system', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(taskId);
    addEvent(db, taskId, 'system', 'FeedbackReportReady', '修订后的结卡报告已通过反馈验证。');
  } else {
    db.prepare(`
      UPDATE tasks
      SET agile_status = 'in review', current_subagent = 'review-agent',
          run_state = 'runnable', closure_status = 'none', review_document_id = NULL,
          next_step = '反馈追加交付已完成，等待重新生成结卡报告',
          last_actor = 'system', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(taskId);
    addEvent(db, taskId, 'system', 'FeedbackDeliveryCompleted', '全部反馈追加交付和独立验证已完成，进入新版结卡报告生成');
  }
}

export async function applyFeedbackVerificationV2(taskId: string, decision: FeedbackVerificationDecision, executionId?: string) {
  const db = await databaseConnection();
  const source = feedbackSourceItemInDb(db, { taskId, commentId: decision.commentId, executionId, pipeline: 'feedback-verify' });
  const row = db.prepare(`
    SELECT feedback_group.*, feedback_batch.task_id
    FROM feedback_groups feedback_group
    JOIN feedback_batches feedback_batch ON feedback_batch.batch_id = feedback_group.batch_id
    JOIN feedback_group_comments link ON link.group_id = feedback_group.group_id
    WHERE feedback_batch.task_id = ? AND link.comment_id = ?
      AND (? OR feedback_group.status = 'ready_for_verification')
      AND (? IS NULL OR feedback_group.group_id = ?)
    ORDER BY feedback_group.created_at DESC
    LIMIT 1
  `).get(taskId, decision.commentId, source ? 1 : 0, source?.scope.feedbackGroupId || null, source?.scope.feedbackGroupId || null) as (FeedbackGroup & { task_id: string }) | undefined;
  if (!row) throw new Error('反馈当前没有可验证的前向工作结果');
  if (decision.verdict === 'resolved' && !decision.evidence.length) throw new Error('反馈标记 resolved 前必须提供验证证据');
  db.transaction(() => {
    const resolved = decision.verdict === 'resolved';
    if (source && executionId) {
      db.prepare(`INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
        VALUES(?, ?, 'feedback_verification', ?, ?) ON CONFLICT(execution_id, kind, receipt_key) DO NOTHING`)
        .run(randomUUID(), executionId, decision.commentId, JSON.stringify({ ...decision, batchId: source.scope.feedbackBatchId,
          groupId: source.scope.feedbackGroupId, itemId: source.item.item_id }));
    }
    db.prepare(`
      UPDATE document_comments
      SET status = ?, feedback_status = ?, verification_json = ?,
          evolution_status = 'pending', resolved_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE comment_id = ?
    `).run(
      resolved ? 'resolved' : 'open',
      resolved ? 'resolved' : 'reopened',
      JSON.stringify({ ...decision, executionId: executionId || null }),
      resolved ? new Date().toISOString() : null,
      decision.commentId,
    );
    const comments = groupCommentIds(db, row.group_id);
    const states = db.prepare(`
      SELECT status, feedback_status FROM document_comments
      WHERE comment_id IN (${comments.map(() => '?').join(', ')})
    `).all(...comments) as { status: string; feedback_status: string }[];
    const groupStatus: FeedbackGroup['status'] = states.some((item) => item.feedback_status === 'reopened')
      ? 'reopened'
      : states.every((item) => item.status === 'resolved') ? 'completed' : 'ready_for_verification';
    db.prepare(`
      UPDATE feedback_groups
      SET status = ?, completed_at = CASE WHEN ? IN ('completed', 'reopened') THEN CURRENT_TIMESTAMP ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
      WHERE group_id = ?
    `).run(groupStatus, groupStatus, row.group_id);
    updateBatchStatusInDb(db, row.batch_id);
    addEvent(
      db,
      taskId,
      'feedback-agent',
      resolved ? 'FeedbackResolved' : 'FeedbackReopened',
      `反馈「${groupDisplayName(row)}」${resolved ? '已通过验证' : '验证未通过'}：${decision.reason}`,
    );
    finalizeTaskAfterFeedbackInDb(db, taskId, row.batch_id);
  })();
  refreshTask(taskId);
}

export async function cancelFeedbackForTask(taskId: string) {
  const db = await databaseConnection();
  db.transaction(() => {
    db.prepare(`
      UPDATE feedback_batches
      SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND status NOT IN ('completed', 'cancelled')
    `).run(taskId);
    db.prepare(`
      UPDATE feedback_groups
      SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE batch_id IN (SELECT batch_id FROM feedback_batches WHERE task_id = ?)
        AND status NOT IN ('completed', 'reopened', 'cancelled')
    `).run(taskId);
  })();
  refreshTask(taskId);
}
