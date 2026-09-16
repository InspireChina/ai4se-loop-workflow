import { build } from 'esbuild';
import { rebuild } from '@electron/rebuild';
import { copyFile, cp, mkdir, readFile, readdir, rm,writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assertDesktopArtifactBoundary } from './desktop-artifact-boundary.mjs';
import { assertHarnessBuildSource } from './harness-source.mjs';
import { writeHarnessArtifact } from './harness-artifact.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const outputRoot = join(projectRoot, 'desktop-runtime');
const standaloneRoot = join(projectRoot, '.next', 'standalone');
const runnerOutput = join(outputRoot, 'desktop-runners');

await assertDesktopArtifactBoundary(standaloneRoot);
const sourceBuild = await assertHarnessBuildSource(projectRoot);
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
await cp(join(projectRoot, 'command-chains'), join(outputRoot, 'command-chains'), { recursive: true });
// Next standalone traces the cache implementation but omits this public
// package entrypoint, which bundled runners import for best-effort revalidation.
await copyFile(join(projectRoot, 'node_modules', 'next', 'cache.js'), join(outputRoot, 'node_modules', 'next', 'cache.js'));
// fdir checks require.resolve('picomatch') before using the picomatch code that
// esbuild already bundled. Keep the tiny package present so that capability
// check behaves the same in the isolated installed runtime.
await rm(join(outputRoot, 'node_modules', 'picomatch'), { recursive: true, force: true });
await cp(join(projectRoot, 'node_modules', 'picomatch'), join(outputRoot, 'node_modules', 'picomatch'), { recursive: true });
await mkdir(runnerOutput, { recursive: true });

const runnerEntries = {
  'ui-server':join(projectRoot,'scripts','loop','ui-server-entry.ts'),
  'agent-runner': join(projectRoot, 'scripts', 'loop', 'agent-runner.ts'),
  'lifecycle-host': join(projectRoot, 'src', 'infrastructure', 'runtime-supervision.ts'),
  'runtime-selection': join(projectRoot, 'src', 'infrastructure', 'runtime-selection.ts'),
  'external-runtime': join(projectRoot, 'src', 'infrastructure', 'native-external-runtime.ts'),
  'external-host': join(projectRoot, 'scripts', 'loop', 'external-host-entry.ts'),
  'windows-contained-command': join(projectRoot, 'scripts', 'loop', 'windows-contained-command-entry.ts'),
  'loop-agent': join(projectRoot, 'scripts', 'loop', 'loop-agent-entry.ts'),
  'loop-admin': join(projectRoot, 'scripts', 'loop', 'loop-admin-entry.ts'),
  'admin-business-worker': join(projectRoot, 'scripts', 'loop', 'admin-business-worker-entry.ts'),
  'verification-worker': join(projectRoot, 'scripts', 'loop', 'verification-worker-entry.ts'),
  'workspace-version': join(projectRoot, 'scripts', 'loop', 'workspace-version-entry.ts'),
  'database-reader': join(projectRoot, 'scripts', 'loop', 'database-reader-entry.ts'),
  'host-service': join(projectRoot, 'scripts', 'loop', 'host-service-entry.ts'),
  'host-configure': join(projectRoot, 'scripts', 'host-service.ts'),
  loopctl: join(projectRoot, 'scripts', 'loop', 'loopctl.ts'),
};

const runnerBuild = await build({
  entryPoints: runnerEntries,
  outdir: runnerOutput,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  // The packaged app does not ship the repository-level node_modules tree.
  // Bundle ordinary JavaScript dependencies into each runner and keep only
  // modules that are deliberately present in the standalone runtime external.
  external: ['better-sqlite3', 'next/cache'],
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  metafile: true,
});

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
for (const [output, metadata] of Object.entries(runnerBuild.metafile.outputs)) {
  if (!output.endsWith('.cjs')) continue;
  const runner = resolve(projectRoot, output);
  const requireFromRunner = createRequire(runner);
  for (const specifier of new Set(metadata.imports.filter((item) => item.external).map((item) => item.path))) {
    if (builtins.has(specifier) || specifier.startsWith('.') || isAbsolute(specifier)) continue;
    const resolvedImport = requireFromRunner.resolve(specifier);
    const relation = relative(outputRoot, resolvedImport);
    if (relation.startsWith('..') || isAbsolute(relation)) {
      throw new Error(`Desktop runner ${output} resolves ${specifier} outside the packaged runtime: ${resolvedImport}`);
    }
  }
}

const finalSource = await assertHarnessBuildSource(projectRoot);
if (finalSource.source.sourceId !== sourceBuild.source.sourceId) throw new Error('Harness source changed during Desktop build');
await copyFile(join(projectRoot, '.next', 'harness-source.json.gz'), join(outputRoot, 'harness-source.json.gz'));
await writeFile(join(outputRoot,'external-ui-protocol.json'),JSON.stringify({version:1,sourceId:finalSource.source.sourceId}));
await mkdir(join(outputRoot, 'harness-tools'), { recursive: true });
for (const file of ['harness-source.mjs', 'harness-source-cli.mjs', 'harness-artifact.mjs']) {
  await copyFile(join(projectRoot, 'scripts', file), join(outputRoot, 'harness-tools', file));
}
await assertDesktopArtifactBoundary(outputRoot);
const artifact = await writeHarnessArtifact(outputRoot);
console.log(`Installed Harness artifact identity: ${artifact.artifactId}`);
console.log(`Desktop runtime created at ${outputRoot}`);
