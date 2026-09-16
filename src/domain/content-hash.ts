import { createHash } from 'node:crypto';

/** Stable content and source-generation identity without storage setup. */
export function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
