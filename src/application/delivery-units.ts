import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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
      if (source.kind === 'acceptance') {
        const acceptanceKey = source.key.startsWith('acceptance:')
          ? source.key.slice('acceptance:'.length)
          : source.key;
        let acceptance = db.prepare(`
          SELECT acceptance_id FROM acceptances
          WHERE task_id = ? AND acceptance_key = ? AND lifecycle = 'active'
        `).get(input.taskId, acceptanceKey) as { acceptance_id: string } | undefined;
        if (!acceptance) {
          const acceptanceId = randomUUID();
          db.prepare(`
            INSERT INTO acceptances(
              acceptance_id, task_id, acceptance_key, scope_type, story_index,
              statement, oracle, source_ref, source_command_chain_draft_id
            ) VALUES(?, ?, ?, 'requirement', NULL, ?, ?, ?, ?)
          `).run(
            acceptanceId,
            input.taskId,
            acceptanceKey,
            source.content,
            source.content,
            source.sourceRef,
            input.sourceCommandChainDraftId || null,
          );
          acceptance = { acceptance_id: acceptanceId };
        }
        db.prepare(`
          INSERT INTO delivery_unit_acceptances(task_id, story_index, acceptance_id, relation)
          VALUES(?, ?, ?, 'assigned')
        `).run(input.taskId, storyIndex, acceptance.acceptance_id);
      }
    }
    const unitAcceptanceId = randomUUID();
    const unitAcceptanceKey = `unit:${unit.key}`;
    db.prepare(`
      INSERT INTO acceptances(
        acceptance_id, task_id, acceptance_key, scope_type, story_index,
        statement, oracle, source_ref, source_command_chain_draft_id
      ) VALUES(?, ?, ?, 'delivery_unit', ?, ?, ?, ?, ?)
    `).run(
      unitAcceptanceId,
      input.taskId,
      unitAcceptanceKey,
      storyIndex,
      unit.acceptance,
      unit.observableOutcome,
      `DELIVERY_UNIT:${input.taskId}:${unit.key}:acceptance`,
      input.sourceCommandChainDraftId || null,
    );
    db.prepare(`
      INSERT INTO delivery_unit_acceptances(task_id, story_index, acceptance_id, relation)
      VALUES(?, ?, ?, 'unit')
    `).run(input.taskId, storyIndex, unitAcceptanceId);
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
