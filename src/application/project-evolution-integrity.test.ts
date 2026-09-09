import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureAgentRuntimeWorkspace } from './agent-profiles';
import { createTask } from './tasks';
import { databaseConnection } from '../infrastructure/database';

test('rejects cross-project Agent evolution runs and observation evidence at the database boundary', async () => {
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const firstProjectId = 'PRJ-evolution-integrity-a';
  const secondProjectId = 'PRJ-evolution-integrity-b';
  db.prepare(`
    INSERT OR IGNORE INTO projects(project_id, name, workspace_root, is_default)
    VALUES(?, '演化完整性 A', ?, 0), (?, '演化完整性 B', ?, 0)
  `).run(
    firstProjectId,
    `${process.env.LOOP_WORKSPACE_ROOT_OVERRIDE}-evolution-a`,
    secondProjectId,
    `${process.env.LOOP_WORKSPACE_ROOT_OVERRIDE}-evolution-b`,
  );
  const firstTaskId = await createTask({ title: '演化证据项目 A', projectId: firstProjectId });
  const secondTaskId = await createTask({ title: '演化证据项目 B', projectId: secondProjectId });
  const executionId = 'EXEC-project-evolution-integrity';
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, delegation_key,
      attempt, status, input_hash, input_json, result_json
    ) VALUES(?, 'run-project-evolution-integrity', ?, 'dev-agent', 'dev', ?, 1, 'applied', ?, '{}', '{"outcome":"completed"}')
  `).run(executionId, firstTaskId, `key-${executionId}`, `hash-${executionId}`);

  assert.throws(() => db.prepare(`
    INSERT INTO agent_evolution_runs(evolution_id, execution_id, agent_id, project_id, status)
    VALUES('EVOLUTION-wrong-project', ?, 'dev-agent', ?, 'running')
  `).run(executionId, secondProjectId), /必须属于 execution 对应项目/);
  db.prepare(`
    INSERT INTO agent_evolution_runs(evolution_id, execution_id, agent_id, project_id, status)
    VALUES('EVOLUTION-correct-project', ?, 'dev-agent', ?, 'running')
  `).run(executionId, firstProjectId);

  const observationId = 'OBS-project-evolution-integrity';
  db.prepare(`
    INSERT INTO project_agent_observations(
      observation_id, project_id, agent_id, fingerprint, category, summary, guidance,
      target, confidence, status, occurrence_count
    ) VALUES(?, ?, 'dev-agent', 'project-evolution-integrity', 'verification',
      '项目证据完整性', '证据只能留在所属项目', 'daily', 0.9, 'observed', 0)
  `).run(observationId, firstProjectId);
  assert.throws(() => db.prepare(`
    INSERT INTO project_agent_observation_occurrences(observation_id, execution_id, task_id, evidence_json)
    VALUES(?, ?, ?, '{}')
  `).run(observationId, executionId, secondTaskId), /必须属于同一项目和需求/);
  db.prepare(`
    INSERT INTO project_agent_observation_occurrences(observation_id, execution_id, task_id, evidence_json)
    VALUES(?, ?, ?, '{}')
  `).run(observationId, executionId, firstTaskId);

  const documentId = 'DOC-project-evolution-integrity';
  const commentId = 'COMMENT-project-evolution-integrity';
  db.prepare(`
    INSERT INTO documents(document_id, task_id, kind, title, content)
    VALUES(?, ?, 'review', '跨项目评论证据', '# review')
  `).run(documentId, secondTaskId);
  db.prepare(`
    INSERT INTO document_comments(
      comment_id, document_id, task_id, document_revision, agent_id, anchor_type, content
    ) VALUES(?, ?, ?, 1, 'dev-agent', 'file', '评论证据')
  `).run(commentId, documentId, secondTaskId);
  assert.throws(() => db.prepare(`
    INSERT INTO project_agent_observation_comment_evidence(observation_id, comment_id)
    VALUES(?, ?)
  `).run(observationId, commentId), /评论证据必须属于同一项目/);
  assert.throws(
    () => db.prepare('UPDATE project_agent_observations SET project_id = ? WHERE observation_id = ?').run(secondProjectId, observationId),
    /不能把已有证据的 Agent 观察切换到其他项目/,
  );
  assert.throws(
    () => db.prepare('UPDATE tasks SET project_id = ? WHERE task_id = ?').run(secondProjectId, firstTaskId),
    /不能把已有 Agent 演化证据的需求切换到其他项目/,
  );
});
