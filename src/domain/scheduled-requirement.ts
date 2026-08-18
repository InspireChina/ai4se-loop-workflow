export const SCHEDULE_RECURRENCE_KINDS = ['once', 'daily', 'weekdays', 'weekly', 'monthly'] as const;
export type ScheduleRecurrenceKind = typeof SCHEDULE_RECURRENCE_KINDS[number];

export type RequirementSchedule = {
  recurrenceKind: ScheduleRecurrenceKind;
  timezone: string;
  localTime: string | null;
  weekday: number | null;
  dayOfMonth: number | null;
  onceAt: string | null;
};

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function assertTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(`不支持的时区：${timezone}`);
  }
}

function formatter(timezone: string) {
  let value = formatters.get(timezone);
  if (!value) {
    assertTimeZone(timezone);
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, value);
  }
  return value;
}

function localParts(instant: Date, timezone: string): LocalDateTime {
  const values = Object.fromEntries(formatter(timezone).formatToParts(instant)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function localEpoch(value: LocalDateTime) {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
}

function localDateTimeToUtc(value: LocalDateTime, timezone: string) {
  let guess = localEpoch(value);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = localParts(new Date(guess), timezone);
    const difference = localEpoch(value) - localEpoch(actual);
    if (difference === 0) return new Date(guess);
    guess += difference;
  }
  // A daylight-saving jump can make a local wall-clock minute nonexistent.
  // Choose the first valid instant after the requested local time on that date.
  const target = localEpoch(value);
  for (let offset = -180; offset <= 360; offset += 1) {
    const candidate = new Date(guess + offset * 60_000);
    const actual = localParts(candidate, timezone);
    if (actual.year === value.year && actual.month === value.month && actual.day === value.day
      && localEpoch(actual) >= target) return candidate;
  }
  throw new Error(`无法解析时区时间：${timezone} ${value.year}-${value.month}-${value.day}`);
}

function parseLocalTime(value: string | null) {
  const match = value?.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error('执行时间必须使用 HH:mm 格式');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function addLocalDays(value: Pick<LocalDateTime, 'year' | 'month' | 'day'>, days: number) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(value: Pick<LocalDateTime, 'year' | 'month' | 'day'>) {
  return new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay();
}

function matchesDate(schedule: RequirementSchedule, value: Pick<LocalDateTime, 'year' | 'month' | 'day'>) {
  const weekday = weekdayOf(value);
  if (schedule.recurrenceKind === 'daily') return true;
  if (schedule.recurrenceKind === 'weekdays') return weekday >= 1 && weekday <= 5;
  if (schedule.recurrenceKind === 'weekly') return weekday === schedule.weekday;
  if (schedule.recurrenceKind === 'monthly') {
    const requested = schedule.dayOfMonth || 1;
    return value.day === Math.min(requested, daysInMonth(value.year, value.month));
  }
  return false;
}

export function nextScheduledOccurrence(schedule: RequirementSchedule, after: Date) {
  assertTimeZone(schedule.timezone);
  if (schedule.recurrenceKind === 'once') {
    const once = schedule.onceAt ? new Date(schedule.onceAt) : null;
    if (!once || Number.isNaN(once.getTime())) throw new Error('单次计划缺少有效执行时间');
    return once.getTime() > after.getTime() ? once : null;
  }
  const time = parseLocalTime(schedule.localTime);
  const startingDate = localParts(after, schedule.timezone);
  for (let offset = 0; offset <= 370 * 5; offset += 1) {
    const date = addLocalDays(startingDate, offset);
    if (!matchesDate(schedule, date)) continue;
    const candidate = localDateTimeToUtc({ ...date, ...time, second: 0 }, schedule.timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error('无法在五年内计算下一次执行时间');
}

export function latestDueScheduledOccurrence(
  schedule: RequirementSchedule,
  firstDue: Date,
  now: Date,
) {
  if (firstDue.getTime() > now.getTime()) return null;
  if (schedule.recurrenceKind === 'once') return firstDue;
  let latest = firstDue;
  for (let occurrence = 0; occurrence < 200_000; occurrence += 1) {
    const next = nextScheduledOccurrence(schedule, latest);
    if (!next || next.getTime() > now.getTime()) return latest;
    latest = next;
  }
  throw new Error('定时计划积压跨度过大，无法计算最近执行时间');
}

export function parseOnceLocalDateTime(value: string, timezone: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error('单次执行时间格式无效');
  return localDateTimeToUtc({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0,
  }, assertTimeZone(timezone));
}

export function formatScheduleInstant(value: string | null, timezone: string) {
  if (!value) return '—';
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}
