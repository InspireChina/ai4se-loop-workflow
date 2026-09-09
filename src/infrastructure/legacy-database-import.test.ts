import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  discoverLegacyProjectDatabases,
  importLegacyProjectDatabase,
  inspectLegacyProjectDatabase,
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
      CREATE TABLE execution_attempts (
        execution_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id)
      );
      CREATE TABLE agent_evolution_runs (
        evolution_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES execution_attempts(execution_id),
        project_id TEXT NOT NULL REFERENCES projects(project_id)
      );
      CREATE TABLE agent_profiles (agent_id TEXT PRIMARY KEY);
      CREATE TABLE project_agent_overlays (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id),
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY(project_id, agent_id)
      );
      CREATE TABLE project_agent_memory_versions (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id),
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY(project_id, agent_id, revision)
      );
      CREATE TRIGGER trg_agent_evolution_runs_same_project_insert
      BEFORE INSERT ON agent_evolution_runs
      WHEN NOT EXISTS (
        SELECT 1
        FROM execution_attempts execution
        JOIN tasks task ON task.task_id = execution.task_id
        WHERE execution.execution_id = NEW.execution_id AND task.project_id = NEW.project_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Agent 演化运行必须属于 execution 对应项目');
      END;
    `;
    const source = new Database(sourcePath);
    source.exec(schema);
    source.prepare(`INSERT INTO projects(project_id, name, workspace_root, is_default) VALUES('PRJ-default', 'old', '/old/path', 1)`).run();
    source.prepare(`INSERT INTO tasks(task_id, title, work_dir, project_id) VALUES('REQ-old', 'historical', '/old/path', 'PRJ-default')`).run();
    source.prepare(`INSERT INTO execution_attempts(execution_id, task_id) VALUES('EXEC-old', 'REQ-old')`).run();
    source.prepare(`INSERT INTO agent_evolution_runs(evolution_id, execution_id, project_id) VALUES('EVO-old', 'EXEC-old', 'PRJ-default')`).run();
    source.prepare(`INSERT INTO agent_profiles(agent_id) VALUES('dev-agent')`).run();
    source.prepare(`INSERT INTO project_agent_overlays(project_id, agent_id, revision, content) VALUES('PRJ-default', 'dev-agent', 3, '历史 Overlay')`).run();
    source.prepare(`INSERT INTO project_agent_memory_versions(project_id, agent_id, revision, content) VALUES('PRJ-default', 'dev-agent', 4, '历史 Memory')`).run();
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
    assert.deepEqual(target.prepare(`SELECT project_id, revision, content FROM project_agent_overlays WHERE agent_id = 'dev-agent'`).get(), {
      project_id: merged.projectId,
      revision: 3,
      content: '历史 Overlay',
    });
    assert.deepEqual(target.prepare(`SELECT project_id, revision, content FROM project_agent_memory_versions WHERE agent_id = 'dev-agent'`).get(), {
      project_id: merged.projectId,
      revision: 4,
      content: '历史 Memory',
    });
    assert.deepEqual(target.prepare(`SELECT execution_id, project_id FROM agent_evolution_runs WHERE evolution_id = 'EVO-old'`).get(), {
      execution_id: 'EXEC-old',
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

test('recovers the workspace identity from a migrated projects table', () => {
  const root = mkdtempSync(join(tmpdir(), 'loopwork-legacy-db-project-identity-'));
  try {
    const sourcePath = join(root, 'loop-ui.db');
    const source = new Database(sourcePath);
    source.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0
      );
    `);
    source.prepare('INSERT INTO projects(project_id, name, workspace_root, is_default) VALUES(?, ?, ?, 1)')
      .run('PRJ-default', '历史项目', join(root, 'workspace'));
    source.close();

    assert.deepEqual(inspectLegacyProjectDatabase(sourcePath), {
      workspaceRoot: join(root, 'workspace'),
      projectName: '历史项目',
      evidence: 'projects',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovers the workspace identity from historical run logs when task work dirs are empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'loopwork-legacy-db-log-identity-'));
  try {
    const sourcePath = join(root, 'loop-ui.db');
    const workspaceRoot = join(root, 'workspace');
    const source = new Database(sourcePath);
    source.exec(`
      CREATE TABLE tasks (task_id TEXT PRIMARY KEY, work_dir TEXT NOT NULL DEFAULT '');
      CREATE TABLE run_logs (log_id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL);
      INSERT INTO tasks(task_id, work_dir) VALUES('REQ-old', '');
    `);
    source.prepare('INSERT INTO run_logs(line) VALUES(?)').run(`[运行] 工作区=${workspaceRoot}\n[运行] 开始执行`);
    source.close();

    assert.deepEqual(inspectLegacyProjectDatabase(sourcePath), {
      workspaceRoot,
      projectName: 'workspace',
      evidence: 'run-logs',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects cross-origin requests before starting a local database migration', async () => {
  const { POST } = await import('../../app/api/data-migration/route');
  const response = await POST(new Request('http://localhost/api/data-migration', {
    method: 'POST',
    headers: { origin: 'https://example.test' },
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Origin 不匹配' });
});
