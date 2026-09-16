import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Validate the actual installed tree, not only esbuild's module graph. Next
 * can trace source files without importing them, and stale output can survive
 * a rebuild. Refuse contamination before replacing a known-good runtime. */
export async function assertDesktopArtifactBoundary(root) {
  const pending = [{ directory: root, prefix: '' }];
  let inspected = 0;
  while (pending.length) {
    const { directory, prefix } = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++inspected > 500000) throw new Error('Desktop artifact exceeds the bounded file inventory');
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (/(?:^|\/)src\/test(?:\/|$)/.test(name)
        || (!name.split('/').includes('node_modules') && /\.(?:test|spec)\.tsx?$/.test(name))) {
        throw new Error(`Desktop runtime contains test-only source: ${name}`);
      }
      // Do not traverse package aliases or external symbolic directories.
      // The runner import-resolution boundary checks packaged dependencies.
      if (entry.isDirectory()) pending.push({ directory: join(directory, entry.name), prefix: name });
    }
  }
}
