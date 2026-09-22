import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [executable, runtimeRoot] = process.argv.slice(2);
if (!executable || !runtimeRoot) {
  throw new Error('Usage: node scripts/verify-desktop-native-runtime.mjs <packaged-electron> <packaged-runtime>');
}

const probe = `
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const root = process.argv[1];
if (!process.versions.electron) throw new Error('Probe did not run under Electron');
const modules = [join(root, 'node_modules', 'better-sqlite3')];
const aliases = join(root, '.next', 'node_modules');
for (const name of readdirSync(aliases)) {
  if (name.startsWith('better-sqlite3-')) modules.push(join(aliases, name));
}
if (modules.length < 2) throw new Error('Next.js better-sqlite3 alias is missing');
for (const modulePath of modules) {
  const Database = require(modulePath);
  const database = new Database(':memory:');
  try {
    if (database.prepare('SELECT 1 AS ok').get().ok !== 1) throw new Error('SQLite query failed');
  } finally {
    database.close();
  }
  console.log('Verified ' + modulePath);
}
console.log('Electron ' + process.versions.electron + ' ABI ' + process.versions.modules);
`;

const result = spawnSync(resolve(executable), ['-e', probe, resolve(runtimeRoot)], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 30_000,
});
if (result.error || result.status !== 0) {
  throw new Error(`Packaged Electron native-module probe failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
}
process.stdout.write(result.stdout);
