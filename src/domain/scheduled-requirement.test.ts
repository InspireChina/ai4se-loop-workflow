import assert from 'node:assert/strict';
import test from 'node:test';
import {
  latestDueScheduledOccurrence,
  nextScheduledOccurrence,
  parseOnceLocalDateTime,
  type RequirementSchedule,
} from './scheduled-requirement';

const base = (overrides: Partial<RequirementSchedule>): RequirementSchedule => ({
  recurrenceKind: 'daily',
  timezone: 'Asia/Shanghai',
  localTime: '09:30',
  weekday: null,
  dayOfMonth: null,
  onceAt: null,
  ...overrides,
});

test('schedules every workday and skips a weekend', () => {
  const schedule = base({ recurrenceKind: 'weekdays' });
  assert.equal(nextScheduledOccurrence(schedule, new Date('2026-08-14T02:00:00.000Z'))?.toISOString(), '2026-08-17T01:30:00.000Z');
});

test('schedules a weekly requirement on the selected local weekday', () => {
  const schedule = base({ recurrenceKind: 'weekly', weekday: 3 });
  assert.equal(nextScheduledOccurrence(schedule, new Date('2026-08-18T10:00:00.000Z'))?.toISOString(), '2026-08-19T01:30:00.000Z');
});

test('clamps monthly day 31 to the final local day of a short month', () => {
  const schedule = base({ recurrenceKind: 'monthly', dayOfMonth: 31 });
  assert.equal(nextScheduledOccurrence(schedule, new Date('2027-02-01T00:00:00.000Z'))?.toISOString(), '2027-02-28T01:30:00.000Z');
});

test('keeps only the latest missed recurring occurrence after downtime', () => {
  const schedule = base({ recurrenceKind: 'daily' });
  const latest = latestDueScheduledOccurrence(
    schedule,
    new Date('2026-08-10T01:30:00.000Z'),
    new Date('2026-08-13T10:00:00.000Z'),
  );
  assert.equal(latest?.toISOString(), '2026-08-13T01:30:00.000Z');
});

test('converts a one-time local form value with its configured timezone', () => {
  assert.equal(parseOnceLocalDateTime('2026-08-18T09:30', 'Asia/Shanghai').toISOString(), '2026-08-18T01:30:00.000Z');
});
