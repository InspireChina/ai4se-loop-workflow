import { createHash } from 'node:crypto';

export const adminHistoryCollections = ['observations', 'evidence', 'attempts', 'followups', 'diagnoses'] as const;
export type AdminHistoryCollection = typeof adminHistoryCollections[number];
export function isAdminHistoryCollection(value: string): value is AdminHistoryCollection {
  return (adminHistoryCollections as readonly string[]).includes(value);
}
export function adminHistoryHash(text: string) { return createHash('sha256').update(text).digest('hex'); }

/** Presentation budget only: underlying immutable records are never clipped
 * or overwritten. Large rows carry a stable index and hash for scoped reads. */
export function boundedAdminHistory(rows: Iterable<unknown>, collection: AdminHistoryCollection, budget: number,
  total = Array.isArray(rows) ? rows.length : 0) {
  const visible: unknown[] = [];
  let used = 2;
  let index = 0;
  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const candidate = serialized.length + 1 <= budget - used ? row : {
      index, truncated: true, collection, contentLength: serialized.length, contentHash: adminHistoryHash(serialized),
      preview: serialized.slice(0, 240),
      read: `history read --collection ${collection} --index ${index} --start 0 --length 8000`,
    };
    const length = JSON.stringify(candidate).length + 1;
    if (used + length > budget) break;
    visible.push(candidate);
    used += length;
    index++;
  }
  return { rows: visible, total, shown: visible.length,
    nextIndex: visible.length < total ? visible.length : null };
}

export function adminHistoryChunk(row: unknown, collection: AdminHistoryCollection, index: number,
  start: number, length: number, expectedHash?: string) {
  const content = JSON.stringify(row);
  const contentHash = adminHistoryHash(content);
  if (expectedHash && expectedHash !== contentHash) throw new Error('历史记录在读取期间发生变化，请从 start=0 重新读取');
  if (start > content.length) throw new Error('历史记录 start 超出内容长度');
  const end = Math.min(content.length, start + length);
  return { collection, index, start, contentHash, contentLength: content.length,
    text: content.slice(start, end), nextStart: end < content.length ? end : null };
}
