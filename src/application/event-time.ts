const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const ISO_TIMESTAMP_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

const shanghaiTimeFormatter = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Formats a stored event timestamp for display in Beijing time.
 * SQLite CURRENT_TIMESTAMP values have no offset but are defined as UTC.
 */
export function formatEventTime(value: string): string {
  let timestamp = value;
  if (SQLITE_UTC_TIMESTAMP.test(value)) {
    timestamp = `${value.replace(' ', 'T')}Z`;
  } else if (!ISO_TIMESTAMP_WITH_ZONE.test(value)) {
    return value;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return value;

  const parts = Object.fromEntries(
    shanghaiTimeFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Generates an unambiguous UTC value for application-managed persistence. */
export function toUtcIsoString(date = new Date()): string {
  return date.toISOString();
}
