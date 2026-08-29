import type Database from 'better-sqlite3';
import type { DeliveryUnitContract } from '../domain/delivery-unit';

export type DeliveryUnitOrigin =
  | 'original'
  | 'feedback_behavior'
  | 'feedback_bug'
  | 'feedback_scope'
  | 'feedback_technical';

export function insertDeliveryUnitContractsInDb(
  db: Database.Database,
  input: {
    taskId: string;
    units: DeliveryUnitContract[];
    originType: DeliveryUnitOrigin;
    originFeedbackBatchId?: string | null;
    correctsStoryIndexes?: number[];
    sourceCommandChainDraftId?: string | null;
  },
) {
  const firstIndex = ((db.prepare(`
    SELECT COALESCE(MAX(story_index), 0) + 1 AS value
    FROM stories
    WHERE task_id = ?
  `).get(input.taskId) as { value: number }).value);
  const indexByKey = new Map(
    input.units.map((unit, offset) => [unit.key, firstIndex + offset]),
  );

  for (const unit of input.units) {
    const storyIndex = indexByKey.get(unit.key)!;
    db.prepare(`
      INSERT INTO stories(
        task_id, story_index, title, directory,
        origin_type, origin_feedback_batch_id, corrects_story_indexes_json,
        unit_key, actor, trigger_condition, observable_outcome, acceptance,
        source_command_chain_draft_id
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.taskId,
      storyIndex,
      unit.title,
      `story-${String(storyIndex).padStart(3, '0')}`,
      input.originType,
      input.originFeedbackBatchId || null,
      input.correctsStoryIndexes?.length ? JSON.stringify(input.correctsStoryIndexes) : null,
      unit.key,
      unit.actor,
      unit.trigger,
      unit.observableOutcome,
      unit.acceptance,
      input.sourceCommandChainDraftId || null,
    );
    for (const source of unit.sourceRefs) {
      db.prepare(`
        INSERT INTO delivery_unit_context_links(
          task_id, story_index, source_key, source_kind, content, source_ref
        ) VALUES(?, ?, ?, ?, ?, ?)
      `).run(
        input.taskId,
        storyIndex,
        source.key,
        source.kind,
        source.content,
        source.sourceRef,
      );
    }
  }

  for (const unit of input.units) {
    const storyIndex = indexByKey.get(unit.key)!;
    for (const dependencyKey of unit.dependsOn) {
      const dependencyIndex = indexByKey.get(dependencyKey);
      if (!dependencyIndex) {
        throw new Error(`交付单元 ${unit.key} 引用了当前计划之外的前置单元 ${dependencyKey}`);
      }
      db.prepare(`
        INSERT INTO delivery_unit_dependencies(
          task_id, story_index, depends_on_story_index
        ) VALUES(?, ?, ?)
      `).run(input.taskId, storyIndex, dependencyIndex);
    }
  }

  return input.units.map((unit) => ({
    key: unit.key,
    storyIndex: indexByKey.get(unit.key)!,
    title: unit.title,
  }));
}
