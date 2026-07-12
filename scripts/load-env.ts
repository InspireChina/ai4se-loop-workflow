import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const explicitEnv = new Set(Object.keys(process.env));

for (const file of ['.env', '.env.local']) {
  let content = '';
  try {
    content = readFileSync(join(process.cwd(), file), 'utf8');
  } catch {
    continue;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || explicitEnv.has(match[1])) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
