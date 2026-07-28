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

test('stores one project-owned Current Prompt and one ephemeral Canary without Prompt layers or history', async () => {
  const db = await databaseConnection();
  const promptTables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'agent_prompts',
        'agent_prompt_overlays',
        'agent_prompt_candidates',
        'agent_prompt_versions',
        'agent_memory_versions'
      )
    ORDER BY name
  `).all() as { name: string }[];
  assert.deepEqual(promptTables.map((row) => row.name), [
    'agent_memory_versions',
    'agent_prompt_candidates',
    'agent_prompts',
  ]);

  const currentPromptPrimaryKey = db.prepare("PRAGMA table_info('agent_prompts')").all() as { name: string; pk: number }[];
  assert.equal(currentPromptPrimaryKey.find((column) => column.name === 'agent_id')?.pk, 1);
  assert.ok(currentPromptPrimaryKey.some((column) => column.name === 'template_version'));
  assert.ok(currentPromptPrimaryKey.some((column) => column.name === 'source'));
  const candidateColumns = db.prepare("PRAGMA table_info('agent_prompt_candidates')").all() as { name: string }[];
  assert.ok(candidateColumns.some((column) => column.name === 'base_prompt_revision'));
  assert.equal(candidateColumns.some((column) => column.name === 'base_overlay_revision'), false);
  const executionColumns = db.prepare("PRAGMA table_info('execution_attempts')").all() as { name: string }[];
  assert.ok(executionColumns.some((column) => column.name === 'prompt_template_version'));
  assert.equal(executionColumns.some((column) => column.name === 'prompt_overlay_revision'), false);
  const profileColumns = db.prepare("PRAGMA table_info('agent_profiles')").all() as { name: string }[];
  assert.equal(profileColumns.some((column) => column.name === 'current_prompt_overlay_revision'), false);

  const candidateIndexes = db.prepare("PRAGMA index_list('agent_prompt_candidates')").all() as { name: string; unique: number }[];
  const uniqueCandidateColumns = candidateIndexes
    .filter((index) => index.unique === 1)
    .map((index) => (db.prepare(`PRAGMA index_info('${index.name}')`).all() as { name: string }[]).map((column) => column.name));
  assert.equal(uniqueCandidateColumns.some((columns) => columns.length === 1 && columns[0] === 'agent_id'), true);
});

test('scopes context Chat write commands to the active turn', async () => {
  const db = await databaseConnection();
  const columns = db.prepare("PRAGMA table_info('task_context_chat_sessions')").all() as { name: string }[];
  assert.ok(columns.some((column) => column.name === 'command_token_hash'));
  const requestTable = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'task_context_chat_change_requests'
  `).get();
  assert.ok(requestTable);
});

test('migrates legacy Prompt layers to one empty project Current Prompt baseline before reseeding', () => {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE agent_profiles (
      agent_id TEXT PRIMARY KEY,
      current_prompt_version INTEGER NOT NULL,
      candidate_prompt_version INTEGER,
      canary_remaining INTEGER NOT NULL,
      prompt_seed_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE execution_attempts (
      execution_id TEXT PRIMARY KEY
    );
    CREATE TABLE agent_prompt_versions (
      agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      evidence_json TEXT,
      PRIMARY KEY(agent_id, version)
    );
    CREATE INDEX idx_agent_prompt_versions_history
      ON agent_prompt_versions(agent_id, version DESC);
    CREATE TABLE agent_observations (
      observation_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    INSERT INTO agent_profiles VALUES('dev-agent', 35, 36, 2, 35, 'old');
    INSERT INTO agent_prompt_versions(
      agent_id, version, content, content_hash, status, source
    ) VALUES
      ('dev-agent', 34, 'old prompt', 'old', 'superseded', 'seed'),
      ('dev-agent', 35, 'current prompt', 'current', 'active', 'human'),
      ('dev-agent', 36, 'candidate prompt', 'candidate', 'candidate', 'evolution');
    INSERT INTO agent_observations VALUES('observation', 'prompt_candidate', 'old');
  `);

  db.exec(readFileSync(resolve(process.cwd(), 'migrations/055_prompt_v1_baseline.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO agent_prompts(agent_id, version, content, content_hash, reason)
    VALUES('dev-agent', 1, 'system template', 'base-hash', 'V1 template')
  `).run();
  db.prepare(`
    INSERT INTO agent_prompt_overlays(
      agent_id, revision, content, content_hash, source, reason
    ) VALUES('dev-agent', 1, 'project customization', 'overlay-hash', 'human', 'project rule')
  `).run();
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/058_project_current_prompt.sql'), 'utf8'));

  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'agent_prompt%'
    ORDER BY name
  `).all() as { name: string }[];
  assert.deepEqual(tables.map((row) => row.name), ['agent_prompt_candidates', 'agent_prompts']);
  const migratedPrompt = db.prepare(`
    SELECT version, template_version, source, content, content_hash
    FROM agent_prompts WHERE agent_id = 'dev-agent'
  `).get() as { version: number; template_version: number; source: string; content: string; content_hash: string };
  assert.equal(migratedPrompt.version, 2);
  assert.equal(migratedPrompt.template_version, 1);
  assert.equal(migratedPrompt.source, 'human');
  assert.match(migratedPrompt.content, /system template/);
  assert.match(migratedPrompt.content, /project customization/);
  assert.equal(migratedPrompt.content_hash, '');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM agent_prompt_candidates').get() as { count: number }).count, 0);
  assert.deepEqual(db.prepare(`
    SELECT current_prompt_version, candidate_prompt_version, canary_remaining, prompt_seed_revision
    FROM agent_profiles WHERE agent_id = 'dev-agent'
  `).get(), {
    current_prompt_version: 2,
    candidate_prompt_version: null,
    canary_remaining: 0,
    prompt_seed_revision: 1,
  });
  assert.equal(
    (db.prepare("SELECT status FROM agent_observations WHERE observation_id = 'observation'").get() as { status: string }).status,
    'rejected',
  );
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

test('repairs incomplete feedback units by returning them to delivery planning', () => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      agile_status TEXT NOT NULL,
      current_subagent TEXT,
      analysis_index INTEGER NOT NULL,
      total_stories INTEGER NOT NULL,
      run_state TEXT NOT NULL,
      blocked_reason TEXT,
      resume_status TEXT,
      resume_pending INTEGER NOT NULL,
      next_step TEXT,
      last_actor TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE delivery_plan_drafts(draft_id TEXT PRIMARY KEY);
    CREATE TABLE feedback_batches (
      batch_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id)
    );
    CREATE TABLE feedback_groups (
      group_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES feedback_batches(batch_id),
      work_type TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE stories (
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      story_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      origin_type TEXT NOT NULL,
      origin_feedback_batch_id TEXT,
      corrects_story_indexes_json TEXT,
      unit_key TEXT,
      actor TEXT,
      trigger_condition TEXT,
      observable_outcome TEXT,
      acceptance TEXT,
      source_delivery_plan_draft_id TEXT REFERENCES delivery_plan_drafts(draft_id),
      PRIMARY KEY(task_id, story_index)
    );
    CREATE TABLE feedback_group_delivery_units (
      group_id TEXT NOT NULL REFERENCES feedback_groups(group_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      story_index INTEGER NOT NULL,
      PRIMARY KEY(group_id, task_id, story_index),
      FOREIGN KEY(task_id, story_index)
        REFERENCES stories(task_id, story_index) ON DELETE CASCADE
    );
    CREATE TABLE task_lanes (
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      lane TEXT NOT NULL,
      status TEXT NOT NULL,
      current_agent TEXT,
      current_story_index INTEGER,
      blocked_reason TEXT,
      resume_pending INTEGER NOT NULL,
      ready_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(task_id, lane)
    );
    CREATE TABLE task_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      actor TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    INSERT INTO tasks(
      task_id, agile_status, current_subagent, analysis_index, total_stories,
      run_state, blocked_reason, resume_pending, next_step, last_actor
    ) VALUES(
      'REQ-feedback-repair', 'in feedback', 'analyst-agent', 1, 2,
      'runnable', '交付单元契约不完整', 0, '分析交付单元 2', 'system'
    );
    INSERT INTO feedback_batches(batch_id, task_id)
    VALUES('BATCH-feedback-repair', 'REQ-feedback-repair');
    INSERT INTO feedback_groups(group_id, batch_id, work_type, status)
    VALUES('GROUP-feedback-repair', 'BATCH-feedback-repair', 'behavior_change', 'executing');
    INSERT INTO stories(
      task_id, story_index, title, directory, origin_type,
      unit_key, actor, trigger_condition, observable_outcome, acceptance
    ) VALUES(
      'REQ-feedback-repair', 1, '既有完整单元', 'story-001', 'original',
      'existing-unit', '用户', '执行既有操作', '获得既有结果', '既有结果可验收'
    );
    INSERT INTO stories(
      task_id, story_index, title, directory, origin_type, origin_feedback_batch_id
    ) VALUES(
      'REQ-feedback-repair', 2, '旧版残缺反馈单元', 'story-002',
      'feedback_behavior', 'BATCH-feedback-repair'
    );
    INSERT INTO feedback_group_delivery_units(group_id, task_id, story_index)
    VALUES('GROUP-feedback-repair', 'REQ-feedback-repair', 2);
    INSERT INTO task_lanes(
      task_id, lane, status, current_agent, current_story_index,
      blocked_reason, resume_pending
    ) VALUES(
      'REQ-feedback-repair', 'analysis', 'system_blocked', 'analyst-agent', 2,
      '交付单元契约不完整', 0
    );
  `);

  db.exec(readFileSync(resolve(process.cwd(), 'migrations/059_repair_incomplete_feedback_units.sql'), 'utf8'));

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM stories WHERE task_id = 'REQ-feedback-repair'").get() as { count: number }).count,
    1,
  );
  assert.deepEqual(
    db.prepare(`
      SELECT total_stories, agile_status, current_subagent, run_state, blocked_reason
      FROM tasks WHERE task_id = 'REQ-feedback-repair'
    `).get(),
    {
      total_stories: 1,
      agile_status: 'in feedback',
      current_subagent: 'story-splitter-agent',
      run_state: 'runnable',
      blocked_reason: null,
    },
  );
  assert.equal(
    (db.prepare("SELECT status FROM feedback_groups WHERE group_id = 'GROUP-feedback-repair'").get() as { status: string }).status,
    'waiting_for_plan',
  );
  assert.deepEqual(
    db.prepare(`
      SELECT status, current_agent, current_story_index, blocked_reason
      FROM task_lanes WHERE task_id = 'REQ-feedback-repair' AND lane = 'analysis'
    `).get(),
    {
      status: 'completed',
      current_agent: null,
      current_story_index: null,
      blocked_reason: null,
    },
  );
  assert.equal(
    (db.prepare("SELECT event_type FROM task_events WHERE task_id = 'REQ-feedback-repair'").get() as { event_type: string }).event_type,
    'IncompleteFeedbackUnitRepaired',
  );
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

test('migrates role drafts and replaces the obsolete verification data model', () => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY);
    CREATE TABLE documents (document_id TEXT PRIMARY KEY);
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
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      story_index, agent, status, last_execution_id
    ) VALUES('DRAFT-development', 'development:REQ-existing:1', 1,
      'development', 'REQ-existing', 1, 'dev-agent', 'editing', 'EXEC-existing')
  `).run();
  db.prepare(`
    INSERT INTO development_drafts(draft_id, summary, implementation_notes)
    VALUES('DRAFT-development', '保留开发结论', '保留实现说明')
  `).run();
  db.prepare(`
    INSERT INTO development_criteria(draft_id, criterion_key, status, evidence, ordinal)
    VALUES
      ('DRAFT-development', 'covered', 'covered', '保留覆盖证据', 1),
      ('DRAFT-development', 'not-covered', 'not_covered', '不保留未覆盖候选', 2)
  `).run();
  db.prepare(`
    INSERT INTO development_changes(draft_id, path, summary, ordinal)
    VALUES('DRAFT-development', 'src/legacy.ts', '不再依赖 Agent 记录的文件', 1)
  `).run();
  db.prepare(`
    INSERT INTO development_tests(draft_id, test_key, command, passed, summary, ordinal)
    VALUES
      ('DRAFT-development', 'passed-check', 'npm test', 1, '保留通过检查', 1),
      ('DRAFT-development', 'failed-check', 'npm run build', 0, '不迁移失败检查', 2)
  `).run();
  db.prepare(`
    INSERT INTO development_risks(draft_id, risk_key, content, ordinal)
    VALUES('DRAFT-development', 'known-risk', '保留残余风险', 1)
  `).run();
  db.prepare(`
    INSERT INTO development_runtime_inputs(
      draft_id, request_key, title, question, why, recommendation, ordinal
    ) VALUES(
      'DRAFT-development', 'preview-url', '预览地址', '使用哪个地址？',
      '需要运行验证', '使用已配置地址', 1
    )
  `).run();
  db.prepare(`
    INSERT INTO development_recovery_resolutions(
      draft_id, recovery_id, summary, evidence, ordinal
    ) VALUES('DRAFT-development', 'REC-1', '已处理恢复事项', '回归通过', 1)
  `).run();
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/043_verification_drafts.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      agent, status, last_execution_id
    ) VALUES('DRAFT-verification', 'verification:REQ-existing:1', 1,
      'verification', 'REQ-existing', 'test-agent', 'editing', 'EXEC-existing')
  `).run();
  db.prepare(`
    INSERT INTO verification_drafts(draft_id, summary)
    VALUES('DRAFT-verification', '保留验证结论')
  `).run();
  db.prepare(`
    INSERT INTO verification_risks(draft_id, risk_key, content, ordinal)
    VALUES('DRAFT-verification', 'legacy-risk', '旧风险草稿', 1)
  `).run();
  db.prepare(`
    INSERT INTO verification_runtime_inputs(
      draft_id, request_key, title, question, why, recommendation, ordinal
    ) VALUES(
      'DRAFT-verification', 'legacy-input', '旧运行信息',
      '旧问题', '旧原因', '旧建议', 1
    )
  `).run();
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/044_feedback_drafts.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      agent, status, last_execution_id
    ) VALUES('DRAFT-feedback', 'feedback:REQ-existing:feedback-triage:batch-1', 1,
      'feedback', 'REQ-existing', 'feedback-agent', 'editing', 'EXEC-existing')
  `).run();
  db.prepare(`
    INSERT INTO feedback_drafts(draft_id, mode)
    VALUES('DRAFT-feedback', 'triage')
  `).run();
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/045_review_drafts.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      agent, status, last_execution_id
    ) VALUES('DRAFT-review', 'review:REQ-existing:closure:report', 1,
      'review', 'REQ-existing', 'review-agent', 'editing', 'EXEC-existing')
  `).run();
  db.prepare(`
    INSERT INTO review_drafts(draft_id, title, summary)
    VALUES('DRAFT-review', '旧结卡标题', '旧结卡草稿')
  `).run();
  db.prepare(`
    INSERT INTO review_evidence(
      draft_id, evidence_key, section_kind, reference, claim, ordinal
    ) VALUES(
      'DRAFT-review', 'legacy-evidence', 'verification',
      'DOC-test', '旧证据', 1
    )
  `).run();
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/046_internal_agent_drafts.sql'), 'utf8'));
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/051_simplify_development_drafts.sql'), 'utf8'));
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/052_two_phase_verification.sql'), 'utf8'));
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/053_review_reconciliation.sql'), 'utf8'));

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
      'development_drafts', 'development_criteria', 'development_checks',
      'verification_drafts', 'verification_plan_scenarios', 'verification_results',
      'feedback_drafts', 'feedback_draft_groups',
      'review_drafts', 'review_required_subjects', 'review_reconciliations',
      'review_reconciliation_evidence', 'review_gaps', 'review_sections',
      'internal_agent_drafts', 'evolution_evaluator_drafts',
      'software_maintenance_drafts'
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
  const development = db.prepare(`
    SELECT draft_id FROM development_drafts WHERE draft_id = 'DRAFT-development'
  `).get();
  const developmentCriteria = db.prepare(`
    SELECT criterion_key, evidence
    FROM development_criteria
    WHERE draft_id = 'DRAFT-development'
    ORDER BY ordinal
  `).all();
  const developmentChecks = db.prepare(`
    SELECT check_key, command, summary
    FROM development_checks
    WHERE draft_id = 'DRAFT-development'
    ORDER BY ordinal
  `).all();
  const removedDevelopmentTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('development_changes', 'development_tests')
  `).all();
  const developmentDraftColumns = db.prepare('PRAGMA table_info(development_drafts)')
    .all() as { name: string }[];
  const developmentCriterionColumns = db.prepare('PRAGMA table_info(development_criteria)')
    .all() as { name: string }[];
  const developmentCheckColumns = db.prepare('PRAGMA table_info(development_checks)')
    .all() as { name: string }[];
  const retainedDevelopmentDetails = {
    risks: db.prepare(`
      SELECT risk_key, content FROM development_risks
      WHERE draft_id = 'DRAFT-development'
    `).all(),
    runtimeInputs: db.prepare(`
      SELECT request_key, title FROM development_runtime_inputs
      WHERE draft_id = 'DRAFT-development'
    `).all(),
    recovery: db.prepare(`
      SELECT recovery_id, summary FROM development_recovery_resolutions
      WHERE draft_id = 'DRAFT-development'
    `).all(),
  };
  const removedVerificationDraft = db.prepare(`
    SELECT phase, spec_revision
    FROM verification_drafts
    WHERE draft_id = 'DRAFT-verification'
  `).get();
  const removedVerificationWorkDraft = db.prepare(`
    SELECT draft_id
    FROM agent_work_drafts
    WHERE draft_id = 'DRAFT-verification'
  `).get();
  const verificationPlanScenarios = db.prepare(`
    SELECT scenario_key, channel
    FROM verification_plan_scenarios
    WHERE draft_id = 'DRAFT-verification'
  `).all();
  const verificationPlanColumns = db.prepare('PRAGMA table_info(verification_plan_scenarios)')
    .all() as { name: string }[];
  const verificationResults = db.prepare(`
    SELECT scenario_key, status
    FROM verification_results
    WHERE draft_id = 'DRAFT-verification'
  `).all();
  const removedVerificationTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'verification_criteria',
      'verification_checks',
      'verification_risks',
      'verification_runtime_inputs',
      'verification_recovery_checks',
      'verification_runs',
      'verification_evidence'
    )
    ORDER BY name
  `).all();
  const feedback = db.prepare(`
    SELECT mode FROM feedback_drafts WHERE draft_id = 'DRAFT-feedback'
  `).get();
  const removedReviewDraft = db.prepare(`
    SELECT draft_id
    FROM agent_work_drafts
    WHERE draft_id = 'DRAFT-review'
  `).get();
  const removedReviewTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('review_evidence', 'review_runtime_inputs')
    ORDER BY name
  `).all();
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
    'development_checks',
    'development_criteria',
    'development_drafts',
    'evolution_evaluator_drafts',
    'feedback_draft_groups',
    'feedback_drafts',
    'internal_agent_drafts',
    'reproduction_drafts',
    'reproduction_steps',
    'review_drafts',
    'review_gaps',
    'review_reconciliation_evidence',
    'review_reconciliations',
    'review_required_subjects',
    'review_sections',
    'software_maintenance_drafts',
    'verification_drafts',
    'verification_plan_scenarios',
    'verification_results',
  ]);
  assert.deepEqual(plan, { rationale: '保留拆分依据', coverage: '保留覆盖说明' });
  assert.deepEqual(reproduction, { expected_behavior: '保留预期', actual_behavior: '保留实际' });
  assert.deepEqual(analysis, { goal: '保留分析目标' });
  assert.deepEqual(development, { draft_id: 'DRAFT-development' });
  assert.deepEqual(developmentCriteria, [{
    criterion_key: 'covered',
    evidence: '保留覆盖证据',
  }]);
  assert.deepEqual(developmentChecks, []);
  assert.deepEqual(removedDevelopmentTables, []);
  assert.deepEqual(developmentDraftColumns.map((column) => column.name), [
    'draft_id',
    'repository_base_commit',
    'initial_workspace_fingerprint',
    'initial_workspace_tree',
    'initial_workspace_changes_json',
  ]);
  assert.deepEqual(
    developmentCriterionColumns.map((column) => column.name),
    ['draft_id', 'criterion_key', 'evidence', 'ordinal'],
  );
  assert.deepEqual(
    developmentCheckColumns.map((column) => column.name),
    [
      'draft_id',
      'check_key',
      'command',
      'command_hash',
      'summary',
      'source_execution_id',
      'source_receipt_key',
      'head_commit',
      'workspace_fingerprint',
      'ordinal',
    ],
  );
  assert.deepEqual(retainedDevelopmentDetails, {
    risks: [{ risk_key: 'known-risk', content: '保留残余风险' }],
    runtimeInputs: [{ request_key: 'preview-url', title: '预览地址' }],
    recovery: [{ recovery_id: 'REC-1', summary: '已处理恢复事项' }],
  });
  assert.equal(removedVerificationDraft, undefined);
  assert.equal(removedVerificationWorkDraft, undefined);
  assert.deepEqual(verificationPlanScenarios, []);
  assert.deepEqual(
    verificationPlanColumns.map((column) => column.name),
    [
      'draft_id',
      'scenario_key',
      'channel',
      'title',
      'setup',
      'steps',
      'expected',
      'coverage_refs_json',
      'ordinal',
    ],
  );
  assert.deepEqual(verificationResults, []);
  assert.deepEqual(removedVerificationTables, []);
  assert.deepEqual(feedback, { mode: 'triage' });
  assert.equal(removedReviewDraft, undefined);
  assert.deepEqual(removedReviewTables, []);
  assert.deepEqual(foreignKeyViolations, []);
  db.close();
});
