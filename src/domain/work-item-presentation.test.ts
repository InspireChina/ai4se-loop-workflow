import assert from 'node:assert/strict';
import test from 'node:test';
import { directWorkItemPresentation } from './work-item-presentation';
import { WORK_ITEM_STATUSES } from './workflow-item';

test('only an actually running Direct work item is displayed as running', () => {
  for (const status of WORK_ITEM_STATUSES) {
    assert.equal(directWorkItemPresentation(status, false).label === '运行中', status === 'running');
  }
  assert.equal(directWorkItemPresentation(undefined, false).label, '等待工作项');
  assert.equal(directWorkItemPresentation('waiting', false).label, '等待处理');
  assert.match(directWorkItemPresentation('waiting', false).detail, /等待输入或介入/);
});

test('pause overrides unfinished Direct work but never rewrites its terminal state', () => {
  for (const status of ['pending', 'ready', 'running', 'waiting', undefined] as const) {
    assert.equal(directWorkItemPresentation(status, true).label, '已暂停');
  }
  for (const status of ['completed', 'cancelled', 'superseded'] as const) {
    assert.deepEqual(directWorkItemPresentation(status, true), directWorkItemPresentation(status, false));
  }
});
