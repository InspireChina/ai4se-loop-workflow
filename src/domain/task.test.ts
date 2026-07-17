import assert from 'node:assert/strict';
import test from 'node:test';
import { assertUpdate, nextDelegation, type TaskState } from './task';

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

test('queues a resumed dev agent while another task owns the code slot', () => {
  assert.equal(nextDelegation(resumedDevTask(), false), null);
});

test('dispatches a resumed dev agent after the code slot is released', () => {
  const delegation = nextDelegation(resumedDevTask(), true);
  assert.equal(delegation?.agent, 'dev-agent');
  assert.equal(delegation?.storyIndex, 4);
});

test('Agents cannot create system blocks, while the Harness can record one', () => {
  const state = resumedDevTask();
  assert.throws(() => assertUpdate(state, 'dev-agent', { agile_status: 'blocked' }, ['agile_status']), /无权设置状态 blocked/);
  assert.doesNotThrow(() => assertUpdate(state, 'system', { agile_status: 'blocked' }, ['agile_status']));
});
