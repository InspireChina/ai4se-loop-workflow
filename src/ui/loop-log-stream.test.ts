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

test('merges successive native OMP assistant messages within one Agent scope', () => {
  const events=parseRunLog([
    '2026-11-02T00:00:00Z [执行器输出] executor=omp agent=dev-agent requirement=REQ-1 flow=dev - Inspecting the workspace.',
    '2026-11-02T00:00:01Z [执行器输出] executor=omp agent=dev-agent requirement=REQ-1 flow=dev - Checking the result.',
  ].join('\n'));
  const visible=appendMergedEvents([],events);
  assert.equal(visible.length,1);
  assert.match(visible[0].detail,/Inspecting.*Checking/);
  assert.equal(buildLogTree(visible).length,1);
});
