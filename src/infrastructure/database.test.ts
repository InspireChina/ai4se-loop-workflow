import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import test from 'node:test';
import { databaseConnection, paths } from './database';

test('database tests use a process-local root outside the repository', () => {
  const repository = resolve(process.cwd());
  const dataRoot = resolve(paths.dataRoot);
  const relation = relative(repository, dataRoot);

  assert.equal(process.env.LOOP_TEST, '1');
  assert.equal(process.env.LOOP_TEST_SETUP_PID, String(process.pid));
  assert.equal(paths.appRoot, repository);
  assert.ok(relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation), `test data root escaped isolation: ${dataRoot}`);
  assert.notEqual(paths.dataRoot, resolve(repository, 'data'));
  assert.match(paths.dbPath, /loop-ui\.db$/);
});

test('materializes persistent task lanes and execution lane correlation', async () => {
  const db = await databaseConnection();
  const laneColumns = db.prepare('PRAGMA table_info(task_lanes)').all() as { name: string }[];
  const executionColumns = db.prepare('PRAGMA table_info(execution_attempts)').all() as { name: string }[];
  const recoveryColumns = db.prepare('PRAGMA table_info(recovery_items)').all() as { name: string }[];
  const runColumns = db.prepare('PRAGMA table_info(loop_runs)').all() as { name: string }[];
  assert.deepEqual(laneColumns.map((column) => column.name), [
    'task_id', 'lane', 'status', 'current_agent', 'current_story_index',
    'blocked_reason', 'resume_pending', 'ready_at', 'updated_at',
  ]);
  assert.equal(executionColumns.some((column) => column.name === 'lane'), true);
  assert.equal(executionColumns.some((column) => column.name === 'lease_owner'), false);
  assert.equal(executionColumns.some((column) => column.name === 'lease_expires_at'), false);
  assert.equal(runColumns.some((column) => column.name === 'heartbeat_at'), true);
  assert.equal(recoveryColumns.some((column) => column.name === 'resolution_json'), true);
  assert.equal(recoveryColumns.some((column) => column.name === 'failure_count'), true);
});

test('migrates legacy waiting and blocked task state into isolated lanes without moving cursors', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      agile_status TEXT NOT NULL,
      current_subagent TEXT,
      analysis_index INTEGER NOT NULL DEFAULT 0,
      dev_index INTEGER NOT NULL DEFAULT 0,
      test_index INTEGER NOT NULL DEFAULT 0,
      total_stories INTEGER NOT NULL DEFAULT 0,
      run_state TEXT NOT NULL DEFAULT 'runnable',
      blocked_reason TEXT,
      resume_pending INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE execution_attempts (
      execution_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO tasks(task_id, agile_status, current_subagent, analysis_index, dev_index, test_index, total_stories, run_state, blocked_reason)
    VALUES
      ('analysis-wait', 'ready for dev', 'analyst-agent', 2, 1, 1, 4, 'waiting_for_answers', 'product decision'),
      ('delivery-block', 'blocked', 'dev-agent', 3, 2, 2, 4, 'system_blocked', 'executor failed');
    INSERT INTO execution_attempts(execution_id, task_id, agent, status)
    VALUES('legacy-execution', 'analysis-wait', 'analyst-agent', 'applied');
  `);
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/028_parallel_task_lanes.sql'), 'utf8'));

  const analysis = db.prepare("SELECT * FROM task_lanes WHERE task_id = 'analysis-wait' AND lane = 'analysis'").get() as { status: string; current_story_index: number; ready_at: string | null };
  const delivery = db.prepare("SELECT * FROM task_lanes WHERE task_id = 'delivery-block' AND lane = 'delivery'").get() as { status: string; current_story_index: number; blocked_reason: string };
  const execution = db.prepare("SELECT lane FROM execution_attempts WHERE execution_id = 'legacy-execution'").get() as { lane: string };
  assert.deepEqual([analysis.status, analysis.current_story_index, analysis.ready_at], ['waiting_for_answers', 3, null]);
  assert.deepEqual([delivery.status, delivery.current_story_index, delivery.blocked_reason], ['system_blocked', 3, 'executor failed']);
  assert.equal(execution.lane, 'analysis');
  db.close();
});
