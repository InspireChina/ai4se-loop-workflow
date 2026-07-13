import assert from 'node:assert/strict';
import test from 'node:test';
import { formatEventTime, toUtcIsoString } from './event-time';

test('treats SQLite CURRENT_TIMESTAMP text as UTC', () => {
  assert.equal(formatEventTime('2026-07-12 09:56:03'), '2026-07-12 17:56:03');
});

test('formats explicit UTC ISO timestamps in Asia/Shanghai', () => {
  assert.equal(formatEventTime('2026-07-12T09:56:03.000Z'), '2026-07-12 17:56:03');
});

test('preserves the instant represented by a numeric ISO offset', () => {
  assert.equal(formatEventTime('2026-07-12T17:56:03+08:00'), '2026-07-12 17:56:03');
});

test('handles UTC to Asia/Shanghai conversion across midnight', () => {
  assert.equal(formatEventTime('2026-07-12 18:30:00'), '2026-07-13 02:30:00');
});

test('returns invalid or timezone-ambiguous input unchanged', () => {
  assert.equal(formatEventTime('not-a-time'), 'not-a-time');
  assert.equal(formatEventTime('2026-07-12T09:56:03'), '2026-07-12T09:56:03');
  assert.equal(formatEventTime('2026-99-99 99:99:99'), '2026-99-99 99:99:99');
});

test('generates application-managed timestamps as explicit UTC ISO values', () => {
  assert.equal(toUtcIsoString(new Date('2026-07-12T09:56:03.123Z')), '2026-07-12T09:56:03.123Z');
});
