import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { documentFilesRoot } from './document-files';

/** Only these content columns leave SQL. Stable node IDs, status, authority and
 * ordering remain queryable state; all options/dependencies/answers share one JSON. */
export const decisionTables = {
  questions: {
    scope: 'task_id',
    fields: ['title', 'question', 'why', 'recommendation', 'answer', 'recommendation_reason',
      'status_reason', 'alternatives_json', 'depends_on_json', 'activation_json'],
    identity: 'question_id', order: 'created_at, question_id',
  },
  command_chain_decisions: {
    scope: 'draft_id', fields: ['content', 'decision_text', 'rationale', 'evidence'],
    identity: "json_array(tree_id, decision_key)", order: 'tree_id, ordinal, decision_key',
  },
} as const;
type DecisionTable = keyof typeof decisionTables;
const isDecisionTable = (value: string): value is DecisionTable => Object.hasOwn(decisionTables, value);
export const decisionFieldName = (column: string) => (({
  content: 'definition', alternatives_json: 'options', depends_on_json: 'dependsOn', activation_json: 'activation',
} as Record<string, string>)[column] || column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()));

export type DecisionTreeFile = { kind: DecisionTable; scopeId: string; taskId: string; path: string; revision: number; updatedAt: string };

/** Register storage functions on the same connection as the domain transaction.
 * No database writes happen inside the JS function: SQL triggers publish the
 * resulting immutable file reference atomically with the state change. A rollback
 * can leave an unreferenced file, but never rewrites a previously published tree. */
export function registerDecisionTreeStorage(db: Database.Database,
  read: (value: unknown) => unknown, reference: (path: string, node?: string, field?: string) => string) {
  db.function('loopwork_store_decision_tree', (tableInput: unknown, scopeInput: unknown, taskInput: unknown, rowsInput: unknown) => {
    const table = String(tableInput), scope = String(scopeInput);
    if (!isDecisionTable(table)) throw new Error('未知决策树存储类型');
    const rows = JSON.parse(String(rowsInput)) as Record<string, unknown>[];
    if (!rows.length) throw new Error('空决策树不需要文件引用');
    const taskId = String(taskInput || '');
    if (!taskId) throw new Error(`决策树缺少所属任务：${scope}`);
    const nodes = rows.map(row => {
      const id = table === 'questions' ? String(row.question_id) : JSON.stringify([row.tree_id, row.decision_key]);
      const node: Record<string, unknown> = { id };
      for (const [column, raw] of Object.entries(row)) {
        if (column === 'decision_file_generation') continue;
        let value = read(raw);
        // Keep data as real JSON objects/arrays, rather than escaped JSON/YAML.
        if (typeof value === 'string' && (column === 'content' || column.endsWith('_json'))) {
          try { value = column === 'content' ? parse(value) : JSON.parse(value); }
          catch { /* Domain validation reports invalid drafts; do not hide the original text. */ }
        }
        node[decisionFieldName(column)] = value;
      }
      return node;
    });
    const content = JSON.stringify({ format: 'loopwork-decision-tree', version: 1, kind: table, taskId, scopeId: scope, nodes }, null, 2) + '\n';
    const digest = createHash('sha256').update(content).digest('hex');
    const path = join(documentFilesRoot(), encodeURIComponent(taskId), 'decisions', table, encodeURIComponent(scope), `${digest}.json`);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, content, { mode: 0o600 }); renameSync(temporary, path); }
      finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
    }
    return reference(path);
  });
  db.function('loopwork_decision_field_ref', (value: unknown, node: unknown, column: unknown) => {
    // Verify the signed full-file reference before issuing a selector into it.
    if (typeof value !== 'string' || read(value) === value) throw new Error('决策树文件引用无效');
    const { path } = JSON.parse(value) as { path: string };
    return reference(path, String(node), decisionFieldName(String(column)));
  });
}

/** Keep the existing domain SQL API while replacing content columns with signed
 * selectors into a complete tree. Internal writes increment generation, so they
 * cannot recursively create snapshots; this also works with recursive triggers on.
 * A single writer transaction publishes all node references and the tree index. */
export function installDecisionTreeStorage(db: Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='decision_tree_files'").get()) return;
  for (const [table, config] of Object.entries(decisionTables)) {
    for (const field of config.fields) for (const event of ['insert', 'update']) {
      db.exec(`DROP TRIGGER IF EXISTS "file_${table}_${field}_${event}"`);
    }
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[];
    const rowJson = `json_object(${columns.map(({name})=>`'${name}', "${name}"`).join(',')})`;
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = event === 'DELETE' ? 'OLD' : 'NEW';
      const scope = `${row}.${config.scope}`;
      const taskId = table === 'questions' ? `${row}.task_id`
        : `COALESCE((SELECT task_id FROM agent_work_drafts WHERE draft_id=${scope}),
            (SELECT task_id FROM decision_tree_files WHERE kind='${table}' AND scope_id=${scope}))`;
      const selector = `(SELECT file_ref FROM decision_tree_files WHERE kind='${table}' AND scope_id=${scope})`;
      const fields = config.fields.map(field => `"${field}" = CASE WHEN "${field}" IS NULL OR "${field}" = '' THEN "${field}"
        ELSE loopwork_decision_field_ref(${selector}, ${config.identity}, '${field}') END`).join(',\n');
      db.exec(`CREATE TRIGGER IF NOT EXISTS decision_file_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table}
        ${event === 'UPDATE' ? 'WHEN NEW.decision_file_generation = OLD.decision_file_generation' : ''}
        BEGIN
          INSERT INTO decision_tree_files(kind, scope_id, task_id, file_ref)
          SELECT '${table}', ${scope}, ${taskId}, loopwork_store_decision_tree('${table}', ${scope}, ${taskId},
            (SELECT json_group_array(${rowJson}) FROM (SELECT * FROM ${table} WHERE ${config.scope}=${scope} ORDER BY ${config.order})))
          WHERE EXISTS(SELECT 1 FROM ${table} WHERE ${config.scope}=${scope})
          ON CONFLICT(kind, scope_id) DO UPDATE SET file_ref=excluded.file_ref, task_id=excluded.task_id,
            revision=decision_tree_files.revision+1, updated_at=CURRENT_TIMESTAMP;
          UPDATE ${table} SET ${fields}, decision_file_generation=decision_file_generation+1
          WHERE ${config.scope}=${scope};
          DELETE FROM decision_tree_files WHERE kind='${table}' AND scope_id=${scope}
            AND NOT EXISTS(SELECT 1 FROM ${table} WHERE ${config.scope}=${scope});
        END;`);
    }
    // Existing file-backed rows only need regrouping once; future opens do no writes.
    const scopes = db.prepare(`SELECT DISTINCT ${config.scope} AS scope FROM ${table} WHERE decision_file_generation=0`).all() as { scope: string }[];
    db.transaction(() => {
      for (const { scope } of scopes) db.prepare(`UPDATE ${table} SET decision_file_generation=decision_file_generation WHERE ${config.scope}=?`).run(scope);
    })();
  }
}

/** Use a SQL accessor for the reference path: ordinary database readers hydrate
 * signed references automatically, while this index needs the actual file path. */
export function listDecisionTreeFiles(db: Database.Database, taskId: string): DecisionTreeFile[] {
  return db.prepare(`SELECT kind, scope_id AS scopeId, task_id AS taskId,
    loopwork_payload_path(file_ref) AS path, revision, updated_at AS updatedAt
    FROM decision_tree_files WHERE task_id=? ORDER BY kind, scope_id`).all(taskId) as DecisionTreeFile[];
}
