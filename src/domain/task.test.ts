import assert from 'node:assert/strict';
import test from 'node:test';
import { nextDelegation, type TaskState } from './task';

function resumedDevTask(): TaskState {
  return {
    task_id: 'TASK-queued', agile_status: 'ready for dev', current_subagent: 'dev-agent',
    analysis_index: 4, dev_index: 3, test_index: 0, total_stories: 4,
    analysis_approved_index: 4, review_approved: 0, resume_status: null,
    resume_pending: 1, blocked_reason: null,
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
