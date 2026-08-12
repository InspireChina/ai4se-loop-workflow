import { build } from 'esbuild';
import { rebuild } from '@electron/rebuild';
import { copyFile, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outputRoot = join(projectRoot, 'desktop-runtime');
const standaloneRoot = join(projectRoot, '.next', 'standalone');
const runnerOutput = join(outputRoot, 'desktop-runners');

await rm(outputRoot, { recursive: true, force: true });
await cp(standaloneRoot, outputRoot, { recursive: true, verbatimSymlinks: true });
// Next's standalone trace only keeps the installed native binary. Restore the
// module sources so electron-rebuild can target Electron's Node ABI in-place.
const nativeModule = join('node_modules', 'better-sqlite3');
await rm(join(outputRoot, nativeModule), { recursive: true, force: true });
await cp(join(projectRoot, nativeModule), join(outputRoot, nativeModule), { recursive: true });
const electronPackage = JSON.parse(await readFile(join(projectRoot, 'node_modules', 'electron', 'package.json'), 'utf8'));
await rebuild({
  buildPath: outputRoot,
  electronVersion: electronPackage.version,
  arch: process.arch,
  projectRootPath: outputRoot,
  onlyModules: ['better-sqlite3'],
  force: true,
});
const nativeBinary = join(nativeModule, 'build', 'Release', 'better_sqlite3.node');
const rebuiltBinary = join(outputRoot, '.better_sqlite3.node');
await copyFile(join(outputRoot, nativeBinary), rebuiltBinary);
await rm(join(outputRoot, nativeModule), { recursive: true, force: true });
await cp(join(standaloneRoot, nativeModule), join(outputRoot, nativeModule), {
  recursive: true,
  verbatimSymlinks: true,
});
await copyFile(rebuiltBinary, join(outputRoot, nativeBinary));
await rm(rebuiltBinary);
const tracedAliases = join(outputRoot, '.next', 'node_modules');
for (const entry of await readdir(tracedAliases, { withFileTypes: true })) {
  if (!entry.name.startsWith('better-sqlite3-')) continue;
  const alias = join(tracedAliases, entry.name);
  await rm(alias, { recursive: true, force: true });
  await cp(join(outputRoot, nativeModule), alias, { recursive: true });
}
await mkdir(join(outputRoot, '.next'), { recursive: true });
await cp(join(projectRoot, '.next', 'static'), join(outputRoot, '.next', 'static'), { recursive: true });
await cp(join(projectRoot, 'migrations'), join(outputRoot, 'migrations'), { recursive: true });
await cp(join(projectRoot, 'app-migrations'), join(outputRoot, 'app-migrations'), { recursive: true });
await mkdir(runnerOutput, { recursive: true });

await build({
  entryPoints: {
    'agent-runner': join(projectRoot, 'scripts', 'loop', 'agent-runner.ts'),
    'dispatch-waiter': join(projectRoot, 'scripts', 'loop', 'dispatch-waiter.ts'),
    'maintenance-runner': join(projectRoot, 'scripts', 'loop', 'maintenance-runner.ts'),
    'loop-agent': join(projectRoot, 'scripts', 'loop', 'loop-agent-entry.ts'),
    loopctl: join(projectRoot, 'scripts', 'loop', 'loopctl.ts'),
  },
  outdir: runnerOutput,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
});

console.log(`Desktop runtime created at ${outputRoot}`);
