import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUIREMENT_PRIORITY_OPTIONS,
  requirementPriority,
  requirementPriorityLabel,
} from './requirement-priority';

test('offers exactly high, medium, and low requirement priorities', () => {
  assert.deepEqual(REQUIREMENT_PRIORITY_OPTIONS, [
    { value: 'P1', label: '高' },
    { value: 'P2', label: '中' },
    { value: 'P3', label: '低' },
  ]);
  assert.equal(requirementPriority('P1'), 'P1');
  assert.equal(requirementPriority('P2'), 'P2');
  assert.equal(requirementPriority('P3'), 'P3');
  assert.throws(() => requirementPriority('P0'), /只能选择高、中或低/);
  assert.throws(() => requirementPriority('other'), /只能选择高、中或低/);
});

test('renders current and legacy stored priorities as user-facing labels', () => {
  assert.equal(requirementPriorityLabel('P1'), '高');
  assert.equal(requirementPriorityLabel('S2'), '中');
  assert.equal(requirementPriorityLabel('P3'), '低');
  assert.equal(requirementPriorityLabel('P0'), '紧急');
  assert.equal(requirementPriorityLabel(null), '未定级');
});
