import { createHash, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import type { AgentResult } from '../domain/agent-result';
import {
  assertReviewClosureGapForward,
  type TaskState,
} from '../domain/task';
import { databaseConnection } from '../infrastructure/database';
import { setTaskLaneStateInDb } from './task-lanes';

type ClosureGap = NonNullable<AgentResult['closureGaps']>[number];

type ForwardingOutcome = 'appended' | 'already_applied' | 'stale';

const gapLabels: Record<ClosureGap['kind'], string> = {
  missing_evidence: '补齐结卡证据',
  fact_conflict: '解决最终事实冲突',
  unresolved_obligation: '完成未闭合义务',
};

function compact(value: string, limit: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function stableSuffix(resultId: string, gapKey: string) {
  return createHash('sha256').update(`${resultId}\u0000${gapKey}`).digest('hex').slice(0, 20);
}

function refreshTask(taskId: string) {
  try {
    revalidatePath('/');
    revalidatePath(`/tasks/${taskId}`);
  } catch {
    // CLI and tests run outside a Next request context.
  }
}

export async function forwardReviewClosureGaps(input: {
  taskId: string;
  sourceResultId: string;
  gaps: ClosureGap[];
  expected: {
    totalStories: number;
    reviewRevision: number;
    reviewDocumentId: string;
  };
}): Promise<ForwardingOutcome> {
  if (!input.gaps.length) throw new Error('Review closure gap 前向处理缺少事实缺口');
  const gapKeys = input.gaps.map((gap) => gap.key);
  if (new Set(gapKeys).size !== gapKeys.length) throw new Error('Review closure gap key 不能重复');
  const db = await databaseConnection();

  const outcome = db.transaction((): ForwardingOutcome => {
    const existing = db.prepare(`
      SELECT gap_key, task_id
      FROM review_gap_delivery_units
      WHERE source_result_id = ?
      ORDER BY gap_key
    `).all(input.sourceResultId) as { gap_key: string; task_id: string }[];
    if (existing.length) {
      const expected = [...gapKeys].sort();
      const actual = existing.map((row) => row.gap_key);
      if (existing.some((row) => row.task_id !== input.taskId)
        || actual.length !== expected.length
        || actual.some((key, index) => key !== expected[index])) {
        throw new Error('Review closure gap 的既有前向映射与当前结果不一致');
      }
      return 'already_applied';
    }

    const task = db.prepare(`
      SELECT task_id, agile_status, current_subagent,
             analysis_index, dev_index, test_index, total_stories,
             spec_resolved_index, run_state, closure_status,
             review_revision, review_document_id, closure_acknowledged_at,
             resume_status, resume_pending, blocked_reason
      FROM tasks
      WHERE task_id = ?
    `).get(input.taskId) as TaskState | undefined;
    if (!task) throw new Error(`需求不存在：${input.taskId}`);
    const activeFeedback = db.prepare(`
      SELECT 1
      FROM feedback_batches
      WHERE task_id = ?
        AND status NOT IN ('completed', 'cancelled')
      LIMIT 1
    `).get(input.taskId);
    if (task.agile_status !== 'in review'
      || task.current_subagent !== 'review-agent'
      || task.closure_status !== 'none'
      || task.total_stories !== input.expected.totalStories
      || task.review_revision !== input.expected.reviewRevision
      || (task.review_document_id || '') !== input.expected.reviewDocumentId
      || activeFeedback) {
      return 'stale';
    }

    const storyIndexes = db.prepare(`
      SELECT story_index
      FROM stories
      WHERE task_id = ?
      ORDER BY story_index
    `).all(input.taskId) as { story_index: number }[];
    if (
      storyIndexes.length !== task.total_stories
      || storyIndexes.some((row, index) => row.story_index !== index + 1)
    ) {
      throw new Error('需求的交付单元序号与 total_stories 不一致，拒绝追加结卡缺口');
    }
    const firstIndex = task.total_stories + 1;
    const sourceDraft = db.prepare(`
      SELECT draft.draft_id
      FROM agent_work_drafts draft
      JOIN agent_results result
        ON result.execution_id = draft.terminal_execution_id
      WHERE result.result_id = ?
        AND draft.draft_type = 'review'
        AND draft.status = 'submitted'
        AND draft.terminal_action = 'complete'
      LIMIT 1
    `).get(input.sourceResultId) as { draft_id: string } | undefined;

    for (const [offset, gap] of input.gaps.entries()) {
      const storyIndex = firstIndex + offset;
      const suffix = stableSuffix(input.sourceResultId, gap.key);
      const title = `${gapLabels[gap.kind]}：${compact(gap.subject, 150)}`;
      db.prepare(`
        INSERT INTO stories(
          task_id, story_index, title, directory,
          unit_key, actor, trigger_condition, observable_outcome, acceptance
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.taskId,
        storyIndex,
        title,
        `story-${String(storyIndex).padStart(3, '0')}`,
        `review-gap:${suffix}`,
        '相关业务角色',
        `结卡事实对账发现「${gapLabels[gap.kind]}」缺口`,
        gap.boundary,
        `独立证据证明缺口已闭合：${gap.boundary}`,
      );

      const context = [
        {
          key: `review-gap:${suffix}:subject`,
          kind: 'change',
          content: `对账对象：${gap.subject}`,
          ref: gap.subject,
        },
        {
          key: `review-gap:${suffix}:reason`,
          kind: 'change',
          content: `缺口类型：${gap.kind}\n缺口原因：${gap.reason}`,
          ref: `REVIEW_GAP:${input.sourceResultId}:${gap.key}:reason`,
        },
        {
          key: `review-gap:${suffix}:boundary`,
          kind: 'acceptance',
          content: `完成边界：${gap.boundary}`,
          ref: `REVIEW_GAP:${input.sourceResultId}:${gap.key}:boundary`,
        },
      ] as const;
      for (const item of context) {
        db.prepare(`
          INSERT INTO delivery_unit_context_links(
            task_id, story_index, source_key, source_kind, content, source_ref
          ) VALUES(?, ?, ?, ?, ?, ?)
        `).run(input.taskId, storyIndex, item.key, item.kind, item.content, item.ref);
      }

      db.prepare(`
        INSERT INTO review_gap_delivery_units(
          source_result_id, gap_key, task_id, story_index,
          subject_ref, gap_kind, reason, boundary
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sourceResultId,
        gap.key,
        input.taskId,
        storyIndex,
        gap.subject,
        gap.kind,
        gap.reason,
        gap.boundary,
      );
      if (sourceDraft) {
        const marked = db.prepare(`
          UPDATE review_gaps
          SET status = 'forwarded',
              forwarded_story_index = ?,
              resolution = '已由 Application 转为前向交付单元'
          WHERE draft_id = ?
            AND gap_key = ?
            AND subject_ref = ?
            AND gap_kind = ?
            AND reason = ?
            AND boundary = ?
            AND status = 'active'
        `).run(
          storyIndex,
          sourceDraft.draft_id,
          gap.key,
          gap.subject,
          gap.kind,
          gap.reason,
          gap.boundary,
        );
        if (marked.changes !== 1) {
          throw new Error(`Review closure gap ${gap.key} 与来源草稿不一致`);
        }
      }
      db.prepare(`
        INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
        VALUES(?, ?, 'system', 'ReviewClosureGapDeliveryUnitAdded', ?)
      `).run(randomUUID(), input.taskId, `Review 对账缺口新增交付单元 ${storyIndex}：${title}`);
    }

    const totalStories = firstIndex + input.gaps.length - 1;
    const prospective: TaskState = {
      ...task,
      agile_status: 'ready for dev',
      current_subagent: 'analyst-agent',
      total_stories: totalStories,
      run_state: 'runnable',
      closure_status: 'none',
      review_document_id: null,
      closure_acknowledged_at: null,
      resume_status: null,
      resume_pending: 0,
      blocked_reason: null,
    };
    assertReviewClosureGapForward(task, prospective);
    db.prepare(`
      UPDATE tasks
      SET agile_status = 'ready for dev',
          current_subagent = 'analyst-agent',
          total_stories = ?,
          run_state = 'runnable',
          closure_status = 'none',
          review_document_id = NULL,
          closure_acknowledged_at = NULL,
          resume_status = NULL,
          resume_pending = 0,
          blocked_reason = NULL,
          completed_at = NULL,
          next_step = ?,
          last_actor = 'system',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(
      totalStories,
      `Review 发现 ${input.gaps.length} 个未闭合事实，已追加交付单元 ${firstIndex}-${totalStories} 并交给交付分析`,
      input.taskId,
    );
    setTaskLaneStateInDb(db, {
      taskId: input.taskId,
      lane: 'analysis',
      status: 'runnable',
    });
    setTaskLaneStateInDb(db, {
      taskId: input.taskId,
      lane: 'delivery',
      status: 'pending',
    });
    db.prepare(`
      INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
      VALUES(?, ?, 'system', 'ReviewClosureGapsForwarded', ?)
    `).run(
      randomUUID(),
      input.taskId,
      `Review 的 ${input.gaps.length} 个事实缺口已转为新的前向交付单元。`,
    );
    return 'appended';
  })();

  if (outcome !== 'stale') refreshTask(input.taskId);
  return outcome;
}
