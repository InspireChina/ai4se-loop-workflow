import assert from 'node:assert/strict';
import test from 'node:test';
import { assertState, assertUpdate, nextDelegation, type TaskState } from './task';

function resumedDevTask(): TaskState {
  return {
    task_id: 'TASK-queued', agile_status: 'ready for dev', current_subagent: 'dev-agent',
    analysis_index: 4, dev_index: 3, test_index: 0, total_stories: 4,
    spec_resolved_index: 4, resume_status: null,
    resume_pending: 1, blocked_reason: null,
    run_state: 'runnable', closure_status: 'none', review_revision: 0,
    review_document_id: null, closure_acknowledged_at: null,
  };
}

test('does not dispatch lane agents from the legacy task-level resume owner', () => {
  assert.throws(() => assertState(resumedDevTask()), /恢复所有权必须保存在对应 Lane/);
  assert.equal(nextDelegation(resumedDevTask(), false), null);
  assert.equal(nextDelegation(resumedDevTask(), true), null);
});

test('Agents cannot create system blocks, while the Harness can record one', () => {
  const state = resumedDevTask();
  assert.throws(() => assertUpdate(state, 'dev-agent', { agile_status: 'blocked' }, ['agile_status']), /无权设置状态 blocked/);
  assert.doesNotThrow(() => assertUpdate(state, 'system', { agile_status: 'blocked' }, ['agile_status']));
});

test('dispatches the Harness-selected task-level Agent after a rewind that retains the code slot', () => {
  const task = resumedDevTask();
  task.resume_pending = 0;
  task.analysis_index = 0;
  task.dev_index = 0;
  task.test_index = 0;
  task.total_stories = 0;
  task.spec_resolved_index = 0;
  task.agile_status = 'in dev';

  for (const [agent, pipeline] of [
    ['backlog-agent', 'backlog'],
    ['repro-agent', 'repro'],
    ['story-splitter-agent', 'split'],
  ] as const) {
    task.current_subagent = agent;
    const delegation = nextDelegation(task, true);
    assert.equal(delegation?.agent, agent);
    assert.equal(delegation?.pipeline, pipeline);
  }
});
