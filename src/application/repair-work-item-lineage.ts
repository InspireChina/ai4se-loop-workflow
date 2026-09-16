import type Database from 'better-sqlite3';

export type RepairWorkItemLineageNode = {
  itemId: string;
  taskId: string;
  workKey: string;
  kind: string;
  storyIndex: number | null;
  revision: number;
  dispatchEpoch: number;
  status: string;
  successorId: string | null;
};

const readNode = (db: Database.Database, taskId: string, itemId: string) => db.prepare(`SELECT
  item_id AS itemId,task_id AS taskId,work_key AS workKey,kind,story_index AS storyIndex,revision,
  dispatch_epoch AS dispatchEpoch,status,superseded_by_item_id AS successorId
  FROM workflow_items WHERE task_id=? AND item_id=?`).get(taskId, itemId) as RepairWorkItemLineageNode | undefined;

/** Resolve only the explicit, persisted rewind chain. Never guess MAX(revision)
 * or jump between work keys: that would silently bind a repair to another
 * contract. The returned lineage includes both the requested source and head. */
export function resolveRepairWorkItemLineageInDb(db: Database.Database, input: {
  taskId: string; itemId: string; itemRevision?: number;
}) {
  const first = readNode(db, input.taskId, input.itemId);
  if (!first || input.itemRevision !== undefined && first.revision !== input.itemRevision) {
    throw new Error('修复接管来源版本已改变或原始工作项不存在');
  }
  const lineage = [first];
  const seen = new Set([first.itemId]);
  let current = first;
  while (current.status === 'superseded') {
    if (!current.successorId) throw new Error('修复接管的工作项替换链不完整');
    const next = readNode(db, input.taskId, current.successorId);
    if (!next || seen.has(next.itemId) || next.workKey !== first.workKey || next.kind !== first.kind
      || next.storyIndex !== first.storyIndex || next.revision <= current.revision) {
      throw new Error('修复接管的工作项替换链缺失、循环或跨越契约身份');
    }
    seen.add(next.itemId);
    lineage.push(next);
    current = next;
  }
  return { source: first, current, lineage };
}

export function repairWorkItemLineageContains(lineage: Array<{ itemId: string; revision: number }>, itemId: string, revision?: number) {
  return lineage.some(node => node.itemId === itemId && (revision === undefined || node.revision === revision));
}
