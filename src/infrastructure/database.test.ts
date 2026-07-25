import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import test from 'node:test';
import { databaseConnection, isDatabaseTestProcess, paths } from './database';

test('does not treat a domain command argument ending in .test.js as a test process', () => {
  assert.equal(isDatabaseTestProcess({}), false);
  assert.equal(isDatabaseTestProcess({ LOOP_TEST: '1' }), true);
  assert.equal(isDatabaseTestProcess({ NODE_TEST_CONTEXT: 'child-v8' }), true);
});

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

test('removes legacy task-level resume ownership from lane agents', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      current_subagent TEXT,
      resume_pending INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO tasks(task_id, current_subagent, resume_pending)
    VALUES
      ('analysis-resume', 'analyst-agent', 1),
      ('delivery-resume', 'test-agent', 1),
      ('control-resume', 'backlog-agent', 1);
  `);
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/034_lane_owned_resume_state.sql'), 'utf8'));

  const rows = db.prepare('SELECT task_id, resume_pending FROM tasks ORDER BY task_id').all() as { task_id: string; resume_pending: number }[];
  assert.deepEqual(rows, [
    { task_id: 'analysis-resume', resume_pending: 0 },
    { task_id: 'control-resume', resume_pending: 1 },
    { task_id: 'delivery-resume', resume_pending: 0 },
  ]);
  db.close();
});

test('adds role drafts without losing progress from previously migrated agents', () => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY);
    CREATE TABLE execution_attempts (
      execution_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      status TEXT NOT NULL
    );
    INSERT INTO tasks(task_id) VALUES('REQ-existing');
    INSERT INTO execution_attempts(execution_id, task_id, status)
    VALUES('EXEC-existing', 'REQ-existing', 'running');
  `);
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/038_agent_command_drafts.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      agent, status, last_execution_id
    ) VALUES('DRAFT-existing', 'requirement-context:REQ-existing', 1,
      'requirement_context', 'REQ-existing', 'backlog-agent', 'editing', 'EXEC-existing')
  `).run();
  db.prepare(`
    INSERT INTO requirement_context_drafts(draft_id, goal)
    VALUES('DRAFT-existing', '保留已有渐进草稿')
  `).run();

  db.exec(readFileSync(resolve(process.cwd(), 'migrations/039_delivery_plan_drafts.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      agent, status, last_execution_id
    ) VALUES('DRAFT-plan', 'delivery-plan:REQ-existing:split:one', 1,
      'delivery_plan', 'REQ-existing', 'story-splitter-agent', 'editing', 'EXEC-existing')
  `).run();
  db.prepare(`
    INSERT INTO delivery_plan_drafts(draft_id, rationale, coverage)
    VALUES('DRAFT-plan', '保留拆分依据', '保留覆盖说明')
  `).run();
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/040_reproduction_drafts.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      agent, status, last_execution_id
    ) VALUES('DRAFT-repro', 'reproduction:REQ-existing:task', 1,
      'reproduction', 'REQ-existing', 'repro-agent', 'editing', 'EXEC-existing')
  `).run();
  db.prepare(`
    INSERT INTO reproduction_drafts(draft_id, expected_behavior, actual_behavior)
    VALUES('DRAFT-repro', '保留预期', '保留实际')
  `).run();
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/041_analysis_drafts.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      agent, status, last_execution_id
    ) VALUES('DRAFT-analysis', 'analysis:REQ-existing:1', 1,
      'analysis', 'REQ-existing', 'analyst-agent', 'editing', 'EXEC-existing')
  `).run();
  db.prepare(`
    INSERT INTO analysis_drafts(draft_id, goal)
    VALUES('DRAFT-analysis', '保留分析目标')
  `).run();
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/025_runtime_input_requests.sql'), 'utf8'));
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/042_development_drafts.sql'), 'utf8'));

  const context = db.prepare(`
    SELECT draft_type, goal
    FROM agent_work_drafts
    JOIN requirement_context_drafts USING(draft_id)
    WHERE draft_id = 'DRAFT-existing'
  `).get() as { draft_type: string; goal: string };
  const deliveryTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'delivery_plan_drafts', 'delivery_plan_units',
      'reproduction_drafts', 'reproduction_steps',
      'analysis_drafts', 'analysis_decisions',
      'development_drafts', 'development_criteria'
    )
    ORDER BY name
  `).all() as { name: string }[];
  const plan = db.prepare(`
    SELECT rationale, coverage FROM delivery_plan_drafts WHERE draft_id = 'DRAFT-plan'
  `).get();
  const reproduction = db.prepare(`
    SELECT expected_behavior, actual_behavior
    FROM reproduction_drafts WHERE draft_id = 'DRAFT-repro'
  `).get();
  const analysis = db.prepare(`
    SELECT goal FROM analysis_drafts WHERE draft_id = 'DRAFT-analysis'
  `).get();
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  assert.deepEqual(context, {
    draft_type: 'requirement_context',
    goal: '保留已有渐进草稿',
  });
  assert.deepEqual(deliveryTables.map((row) => row.name), [
    'analysis_decisions',
    'analysis_drafts',
    'delivery_plan_drafts',
    'delivery_plan_units',
    'development_criteria',
    'development_drafts',
    'reproduction_drafts',
    'reproduction_steps',
  ]);
  assert.deepEqual(plan, { rationale: '保留拆分依据', coverage: '保留覆盖说明' });
  assert.deepEqual(reproduction, { expected_behavior: '保留预期', actual_behavior: '保留实际' });
  assert.deepEqual(analysis, { goal: '保留分析目标' });
  assert.deepEqual(foreignKeyViolations, []);
  db.close();
});
