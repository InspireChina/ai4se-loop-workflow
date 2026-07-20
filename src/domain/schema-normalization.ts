export function omitNullObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullObjectProperties);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, omitNullObjectProperties(item)]),
  );
}
