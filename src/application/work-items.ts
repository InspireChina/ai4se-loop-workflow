import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  legacyWorkKeyForExecution,
  projectLegacyDeliveryWorkflow,
  type LegacyLaneProjection,
  type WorkItemDependencyProjection,
  type WorkItemProjection,
  type WorkItemStatus,
} from '../domain/workflow-item';
import { databaseConnection, hash } from '../infrastructure/database';

type Db = Database.Database;

type LegacyTaskRow = {
  task_id: string;
  item_type: string;
  agile_status: string;
  run_state: string;
  current_subagent: string | null;
  total_stories: number;
  analysis_index: number;
  dev_index: number;
  test_index: number;
};

type LegacyLaneRow = {
  lane: 'analysis' | 'delivery';
  status: LegacyLaneProjection['status'];
  current_agent: string | null;
  current_story_index: number | null;
  resume_pending: number;
};

export type WorkflowItemRow = {
  item_id: string;
  task_id: string;
  work_key: string;
  revision: number;
  kind: string;
  title: string;
  story_index: number | null;
  agent: string | null;
  pipeline: string | null;
  lane: string | null;
  status: WorkItemStatus;
  origin: 'native' | 'legacy_projection';
  source_state_hash: string | null;
  completion_authority: 'agent' | 'system' | 'arbitration' | 'human' | null;
  completion_reason: string | null;
  superseded_by_item_id: string | null;
  ready_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  dispatch_epoch: number;
  resume_pending: number;
  context_json?: string;
};

export type WorkflowDependencyRow = {
  item_id: string;
  depends_on_item_id: string;
  dependency_kind: 'completion' | 'ordering';
  work_key: string;
  depends_on_work_key: string;
};

function laneProjection(row: LegacyLaneRow | undefined): LegacyLaneProjection | undefined {
  if (!row) return undefined;
  return {
    status: row.status,
    currentAgent: row.current_agent,
    currentStoryIndex: row.current_story_index,
    resumePending: row.resume_pending,
  };
}

function upsertProjectedItem(
  db: Db,
  taskId: string,
  sourceStateHash: string,
  item: WorkItemProjection,
) {
  const active = db.prepare(`
    SELECT * FROM workflow_items
    WHERE task_id = ? AND work_key = ?
      AND status NOT IN ('superseded', 'cancelled')
    ORDER BY revision DESC
    LIMIT 1
  `).get(taskId, item.workKey) as WorkflowItemRow | undefined;
  if (active?.origin === 'native') return active.item_id;
  if (active && ['pending', 'ready', 'running'].includes(item.status)
    && db.prepare(`
      SELECT 1 FROM interventions WHERE item_id = ?
        AND status IN ('pending', 'running', 'awaiting_human') LIMIT 1
    `).get(active.item_id)) {
    item = { ...item, status: 'waiting' };
  }
  if (active?.origin === 'legacy_projection'
    && active.status === 'completed'
    && item.status !== 'completed') {
    db.prepare(`
      UPDATE workflow_items
      SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
      WHERE item_id = ?
    `).run(active.item_id);
  }
  const mutableActive = active?.status === 'completed' && item.status !== 'completed' ? undefined : active;
  const latestProjection = mutableActive || db.prepare(`
    SELECT * FROM workflow_items
    WHERE task_id = ? AND work_key = ? AND origin = 'legacy_projection'
    ORDER BY revision DESC
    LIMIT 1
  `).get(taskId, item.workKey) as WorkflowItemRow | undefined;
  const reusableProjection = mutableActive
    || (latestProjection?.status === 'cancelled' && item.status === 'cancelled' ? latestProjection : undefined);
  if (reusableProjection) {
    db.prepare(`
      UPDATE workflow_items
      SET kind = ?, title = ?, story_index = ?, agent = ?, pipeline = ?, lane = ?,
          status = ?, source_state_hash = ?,
          ready_at = CASE WHEN ? = 'ready' THEN COALESCE(ready_at, CURRENT_TIMESTAMP) ELSE NULL END,
          started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
          completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
      WHERE item_id = ?
    `).run(
      item.kind,
      item.title,
      item.storyIndex,
      item.agent,
      item.pipeline,
      item.lane,
      item.status,
      sourceStateHash,
      item.status,
      item.status,
      item.status,
      reusableProjection.item_id,
    );
    return reusableProjection.item_id;
  }

  const revision = (db.prepare(`
    SELECT COALESCE(MAX(revision), 0) + 1 AS revision
    FROM workflow_items WHERE task_id = ? AND work_key = ?
  `).get(taskId, item.workKey) as { revision: number }).revision;
  const itemId = randomUUID();
  db.prepare(`
    INSERT INTO workflow_items(
      item_id, task_id, work_key, revision, kind, title, story_index,
      agent, pipeline, lane, status, origin, source_state_hash,
      ready_at, started_at, completed_at
    ) VALUES(
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy_projection', ?,
      CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP END,
      CASE WHEN ? = 'running' THEN CURRENT_TIMESTAMP END,
      CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP END
    )
  `).run(
    itemId,
    taskId,
    item.workKey,
    revision,
    item.kind,
    item.title,
    item.storyIndex,
    item.agent,
    item.pipeline,
    item.lane,
    item.status,
    sourceStateHash,
    item.status,
    item.status,
    item.status,
  );
  return itemId;
}

function replaceProjectedDependencies(
  db: Db,
  itemIds: Map<string, string>,
  dependencies: WorkItemDependencyProjection[],
) {
  const ids = [...itemIds.values()].filter((itemId) => Boolean(db.prepare(`
    SELECT 1 FROM workflow_items WHERE item_id = ? AND origin = 'legacy_projection'
  `).get(itemId)));
  const projectedIds = new Set(ids);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(`DELETE FROM workflow_dependencies WHERE item_id IN (${placeholders})`).run(...ids);
  }
  const insert = db.prepare(`
    INSERT OR REPLACE INTO workflow_dependencies(item_id, depends_on_item_id, dependency_kind)
    VALUES(?, ?, ?)
  `);
  for (const dependency of dependencies) {
    const itemId = itemIds.get(dependency.workKey);
    const dependsOnItemId = itemIds.get(dependency.dependsOnWorkKey);
    if (!itemId || !dependsOnItemId || !projectedIds.has(itemId)) continue;
    insert.run(itemId, dependsOnItemId, dependency.dependencyKind);
  }
}

function attachLegacyHumanInterventionsInDb(db: Db, task: LegacyTaskRow) {
  if (task.agile_status === 'in feedback') return;
  const inputs = db.prepare(`
    SELECT intervention.intervention_id, question.source_agent AS agent, question.story_index
    FROM questions question
    JOIN interventions intervention ON intervention.intervention_id = question.intervention_id
    WHERE question.task_id = ? AND question.status = 'pending'
      AND intervention.item_id IS NULL AND intervention.status = 'awaiting_human'
    UNION ALL
    SELECT intervention.intervention_id, request.source_agent AS agent, request.story_index
    FROM runtime_input_requests request
    JOIN interventions intervention ON intervention.intervention_id = request.intervention_id
    WHERE request.task_id = ? AND request.status = 'pending'
      AND intervention.item_id IS NULL
      AND intervention.status IN ('pending', 'running', 'awaiting_human')
  `).all(task.task_id, task.task_id) as {
    intervention_id: string;
    agent: string | null;
    story_index: number | null;
  }[];
  for (const input of inputs) {
    const item = activeWorkflowItemForLegacyExecutionInDb(db, {
      taskId: task.task_id,
      agent: input.agent && input.agent !== 'human' ? input.agent : task.current_subagent || 'backlog-agent',
      pipeline: 'resume',
      storyIndex: input.story_index,
    });
    if (!item || ['completed', 'superseded', 'cancelled'].includes(item.status)) continue;
    db.prepare(`
      UPDATE interventions SET item_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE intervention_id = ? AND item_id IS NULL
    `).run(item.item_id, input.intervention_id);
    db.prepare(`
      UPDATE workflow_items SET status = 'waiting', ready_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE item_id = ? AND status IN ('pending', 'ready', 'running')
    `).run(item.item_id);
  }
}

/**
 * Compatibility adapter for tasks not yet adopted by the native graph engine.
 * Native nodes and edges are never overwritten. Unadopted historical tasks
 * cannot dispatch; their old fields are imported only at the upgrade boundary.
 */
export function syncLegacyDeliveryWorkItemsInDb(db: Db, taskId: string) {
  const engine = db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?')
    .get(taskId) as { workflow_engine: string } | undefined;
  if (engine?.workflow_engine === 'native') {
    return { sourceStateHash: null, items: listWorkflowItemsInDb(db, taskId), dependencies: listWorkflowDependenciesInDb(db, taskId) };
  }
  const task = db.prepare(`
      SELECT task_id, item_type, agile_status, run_state, current_subagent, total_stories,
             analysis_index, dev_index, test_index
      FROM tasks WHERE task_id = ?
    `).get(taskId) as LegacyTaskRow | undefined;
  if (!task) throw new Error(`需求不存在：${taskId}`);
  const lanes = db.prepare(`
      SELECT lane, status, current_agent, current_story_index, resume_pending
      FROM task_lanes WHERE task_id = ? AND lane IN ('analysis', 'delivery')
    `).all(taskId) as LegacyLaneRow[];
  const analysisLane = lanes.find((lane) => lane.lane === 'analysis');
  const deliveryLane = lanes.find((lane) => lane.lane === 'delivery');
  const sourceState = {
    taskStatus: task.agile_status,
    itemType: task.item_type,
    runState: task.run_state,
    currentAgent: task.current_subagent,
    totalStories: task.total_stories,
    analysisIndex: task.analysis_index,
    devIndex: task.dev_index,
    testIndex: task.test_index,
    analysisLane: laneProjection(analysisLane),
    deliveryLane: laneProjection(deliveryLane),
  };
  const projection = projectLegacyDeliveryWorkflow({ taskId, ...sourceState });
  const projectedKeys = new Set(projection.items.map((item) => item.workKey));
  const activeLegacy = db.prepare(`
      SELECT item_id, work_key FROM workflow_items
      WHERE task_id = ? AND origin = 'legacy_projection'
        AND status NOT IN ('superseded', 'cancelled')
    `).all(taskId) as { item_id: string; work_key: string }[];
  for (const item of activeLegacy) {
    if (projectedKeys.has(item.work_key)) continue;
    db.prepare(`
        UPDATE workflow_items
        SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
        WHERE item_id = ?
      `).run(item.item_id);
  }

  const sourceStateHash = hash(JSON.stringify(sourceState));
  const itemIds = new Map<string, string>();
  for (const item of projection.items) {
    itemIds.set(item.workKey, upsertProjectedItem(db, taskId, sourceStateHash, item));
  }
  replaceProjectedDependencies(db, itemIds, projection.dependencies);
  attachLegacyHumanInterventionsInDb(db, task);
  return {
    sourceStateHash,
    items: listWorkflowItemsInDb(db, taskId),
    dependencies: listWorkflowDependenciesInDb(db, taskId),
  };
}

export async function syncLegacyDeliveryWorkItems(taskId: string) {
  const db = await databaseConnection();
  return db.transaction(() => syncLegacyDeliveryWorkItemsInDb(db, taskId)).immediate();
}

function listWorkflowItemsInDb(db: Db, taskId: string) {
  return db.prepare(`
    SELECT * FROM workflow_items
    WHERE task_id = ?
    ORDER BY CASE lane WHEN 'control' THEN 0 WHEN 'analysis' THEN 1 ELSE 2 END,
             COALESCE(story_index, 0), work_key, revision
  `).all(taskId) as WorkflowItemRow[];
}

function listWorkflowDependenciesInDb(db: Db, taskId: string) {
  return db.prepare(`
    SELECT dependency.item_id, dependency.depends_on_item_id, dependency.dependency_kind,
           item.work_key, upstream.work_key AS depends_on_work_key
    FROM workflow_dependencies dependency
    JOIN workflow_items item ON item.item_id = dependency.item_id
    JOIN workflow_items upstream ON upstream.item_id = dependency.depends_on_item_id
    WHERE item.task_id = ?
      AND item.status NOT IN ('superseded', 'cancelled')
      AND upstream.status NOT IN ('superseded', 'cancelled')
    ORDER BY item.work_key, upstream.work_key
  `).all(taskId) as WorkflowDependencyRow[];
}

export async function listWorkflowItems(taskId: string) {
  return listWorkflowItemsInDb(await databaseConnection(), taskId);
}

export async function listWorkflowDependencies(taskId: string) {
  return listWorkflowDependenciesInDb(await databaseConnection(), taskId);
}

export function readyWorkflowItemsForTaskInDb(db: Db, taskId: string) {
  return db.prepare(`
    SELECT * FROM workflow_items item
    WHERE item.task_id = ? AND item.status = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_dependencies dependency
        JOIN workflow_items upstream ON upstream.item_id = dependency.depends_on_item_id
        WHERE dependency.item_id = item.item_id AND upstream.status != 'completed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM interventions intervention
        WHERE intervention.item_id = item.item_id
          AND intervention.status IN ('pending', 'running', 'awaiting_human')
      )
    ORDER BY CASE lane WHEN 'control' THEN 0 WHEN 'delivery' THEN 1 ELSE 2 END,
             COALESCE(story_index, 0), work_key, revision DESC
  `).all(taskId) as WorkflowItemRow[];
}

export function activeWorkflowItemForLegacyExecutionInDb(db: Db, input: {
  taskId: string;
  agent: string;
  pipeline: string;
  storyIndex: number | null;
}) {
  // Native input/resume requests are attached to the actual active role,
  // including Feedback roles which have no legacy cursor-derived work key.
  const native = db.prepare(`SELECT item.* FROM workflow_items item JOIN tasks task ON task.task_id = item.task_id
    WHERE item.task_id = ? AND task.workflow_engine = 'native' AND item.origin = 'native'
      AND item.agent = ? AND item.story_index IS ? AND item.status IN ('running', 'waiting', 'ready')
    ORDER BY CASE item.status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, item.created_at LIMIT 1`)
    .get(input.taskId, input.agent, input.storyIndex) as WorkflowItemRow | undefined;
  if (native && input.pipeline === 'resume') return native;
  const workKey = legacyWorkKeyForExecution(input);
  if (!workKey) return null;
  return db.prepare(`
    SELECT * FROM workflow_items
    WHERE task_id = ? AND work_key = ?
      AND status NOT IN ('superseded', 'cancelled')
    ORDER BY revision DESC
    LIMIT 1
  `).get(input.taskId, workKey) as WorkflowItemRow | undefined || null;
}
