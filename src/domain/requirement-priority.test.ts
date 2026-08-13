import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REQUIREMENT_PRIORITY,
  REQUIREMENT_PRIORITY_OPTIONS,
  normalizedRequirementPriority,
  requirementPriority,
  requirementPriorityLabel,
  requirementPriorityRank,
} from './requirement-priority';

test('offers numeric requirement priorities from 9 down to 1', () => {
  assert.equal(DEFAULT_REQUIREMENT_PRIORITY, '5');
  assert.deepEqual(REQUIREMENT_PRIORITY_OPTIONS.map((option) => option.value), ['9', '8', '7', '6', '5', '4', '3', '2', '1']);
  assert.equal(REQUIREMENT_PRIORITY_OPTIONS[0].label, '9 · 最高');
  assert.equal(REQUIREMENT_PRIORITY_OPTIONS.at(-1)?.label, '1 · 最低');
  assert.equal(requirementPriority('9'), '9');
  assert.equal(requirementPriority(5), '5');
  assert.equal(requirementPriority('1'), '1');
  assert.throws(() => requirementPriority('P1'), /1 到 9/);
  assert.throws(() => requirementPriority('10'), /1 到 9/);
  assert.throws(() => requirementPriority('0'), /1 到 9/);
});

test('normalizes legacy priorities while ranking 9 as highest', () => {
  assert.equal(normalizedRequirementPriority('P1'), '9');
  assert.equal(normalizedRequirementPriority('S2'), '5');
  assert.equal(normalizedRequirementPriority('P3'), '1');
  assert.equal(requirementPriorityLabel('8'), '8');
  assert.equal(requirementPriorityLabel('P2'), '5');
  assert.equal(requirementPriorityLabel(null), '未设置');
  assert.ok(requirementPriorityRank('9') > requirementPriorityRank('8'));
  assert.ok(requirementPriorityRank('8') > requirementPriorityRank('1'));
});
