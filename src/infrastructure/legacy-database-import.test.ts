import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  discoverLegacyProjectDatabases,
  importLegacyProjectDatabase,
  legacyProjectDatabasePath,
  mergeLegacyProjectDatabase,
} from './legacy-database-import';

test('imports an arbitrary historical project database into the global path without changing the source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loopwork-global-db-import-'));
  try {
    const workspaceRoot = join(root, 'project');
    const dataRoot = join(root, 'data');
    mkdirSync(workspaceRoot, { recursive: true });
    const sourcePath = legacyProjectDatabasePath(dataRoot, workspaceRoot);
    mkdirSync(dirname(sourcePath), { recursive: true });
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE historical_data(id TEXT PRIMARY KEY, value TEXT); INSERT INTO historical_data VALUES('row-1', 'preserved');");
    source.close();

    assert.deepEqual(discoverLegacyProjectDatabases(dataRoot), [sourcePath]);

    const result = await importLegacyProjectDatabase({ dataRoot, workspaceRoot });
    assert.equal(result.status, 'imported');
    const target = new Database(result.targetPath, { readonly: true });
    assert.deepEqual(target.prepare('SELECT * FROM historical_data').get(), { id: 'row-1', value: 'preserved' });
    target.close();
    const unchangedSource = new Database(sourcePath, { readonly: true });
    assert.deepEqual(unchangedSource.prepare('SELECT * FROM historical_data').get(), { id: 'row-1', value: 'preserved' });
    unchangedSource.close();
    assert.equal((await importLegacyProjectDatabase({ dataRoot, workspaceRoot })).status, 'global-exists');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merges a migrated single-project database into an existing global database idempotently', () => {
  const root = mkdtempSync(join(tmpdir(), 'loopwork-global-db-merge-'));
  try {
    const sourcePath = join(root, 'legacy', 'loop-ui.db');
    const targetPath = join(root, 'global', 'loop-ui.db');
    const workspaceRoot = join(root, 'historical-project');
    mkdirSync(dirname(sourcePath), { recursive: true });
    mkdirSync(dirname(targetPath), { recursive: true });
    const schema = `
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_root TEXT NOT NULL UNIQUE,
        description TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        work_dir TEXT NOT NULL DEFAULT '',
        project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT
      );
    `;
    const source = new Database(sourcePath);
    source.exec(schema);
    source.prepare(`INSERT INTO projects(project_id, name, workspace_root, is_default) VALUES('PRJ-default', 'old', '/old/path', 1)`).run();
    source.prepare(`INSERT INTO tasks(task_id, title, work_dir, project_id) VALUES('REQ-old', 'historical', '/old/path', 'PRJ-default')`).run();
    source.close();

    const target = new Database(targetPath);
    target.exec(`
      PRAGMA foreign_keys = ON;
      ${schema}
      CREATE TABLE legacy_project_database_imports (
        source_db_path TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO projects(project_id, name, workspace_root, is_default)
      VALUES('PRJ-default', 'current', '/current/path', 1);
    `);
    const merged = mergeLegacyProjectDatabase({ target, sourcePath, workspaceRoot });
    assert.equal(merged.status, 'imported');
    assert.match(merged.projectId, /^PRJ-legacy-/);
    assert.deepEqual(target.prepare(`SELECT title, work_dir, project_id FROM tasks WHERE task_id = 'REQ-old'`).get(), {
      title: 'historical',
      work_dir: workspaceRoot,
      project_id: merged.projectId,
    });
    assert.equal(mergeLegacyProjectDatabase({ target, sourcePath, workspaceRoot }).status, 'already-imported');
    assert.equal((target.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 1);
    target.close();

    const unchanged = new Database(sourcePath, { readonly: true });
    assert.deepEqual(unchanged.prepare(`SELECT work_dir, project_id FROM tasks WHERE task_id = 'REQ-old'`).get(), {
      work_dir: '/old/path',
      project_id: 'PRJ-default',
    });
    unchanged.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
