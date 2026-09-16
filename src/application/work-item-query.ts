import type Database from 'better-sqlite3';
import type { WorkflowItemRow } from './work-items';
type Db = Database.Database;

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
