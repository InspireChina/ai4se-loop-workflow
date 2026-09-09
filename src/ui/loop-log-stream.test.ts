import assert from 'node:assert/strict';
import test from 'node:test';
import { appendMergedEvents, buildLogTree, defaultVisibleRunLogLimit } from '../../app/loop-log-stream';
import { parseRunLog } from '../application/run-log';
import type { ParsedRunLog } from '../application/run-log';

test('keeps only the latest 500 visible run log events by default', () => {
  const events = Array.from({ length: defaultVisibleRunLogLimit + 1 }, (_, index): ParsedRunLog => ({
    timestamp: `2026-09-08T00:00:${String(index).padStart(3, '0')}Z`,
    title: `Event ${index}`,
    detail: `Detail ${index}`,
    status: 'info',
    kind: 'run',
    meta: {},
    raw: `Event ${index}`,
  }));

  const visible = appendMergedEvents([], events);

  assert.equal(visible.length, 500);
  assert.equal(visible[0].title, 'Event 1');
  assert.equal(visible.at(-1)?.title, 'Event 500');
});

test('folds a Cursor reconnect sequence into one restored connection event', () => {
  const events = parseRunLog([
    '2026-09-09T05:20:29.639Z [执行器事件] executor=cursor lane=control agent=idea-context-agent requirement=REQ-1 unit=- flow=ba-intent - {"type":"connection","subtype":"reconnecting","session_id":"session-1","attempt":1}',
    '2026-09-09T05:20:31.668Z [执行器事件] executor=cursor lane=control agent=idea-context-agent requirement=REQ-1 unit=- flow=ba-intent - {"type":"retry","subtype":"starting","session_id":"session-1","attempt":1}',
    '2026-09-09T05:21:01.677Z [执行器事件] executor=cursor lane=control agent=idea-context-agent requirement=REQ-1 unit=- flow=ba-intent - {"type":"connection","subtype":"reconnecting","session_id":"session-1","attempt":2}',
    '2026-09-09T05:21:06.868Z [执行器事件] executor=cursor lane=control agent=idea-context-agent requirement=REQ-1 unit=- flow=ba-intent - {"type":"connection","subtype":"reconnected","session_id":"session-1"}',
  ].join('\n'));

  const visible = appendMergedEvents([], events);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].title, 'Cursor 连接已恢复');
  assert.equal(visible[0].status, 'success');
  assert.equal(visible[0].detail, '重试 2 次，耗时 37 秒');

  const tree = buildLogTree(visible);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].title, '需求意图 Agent');
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].title, 'Cursor 连接已恢复');
});
