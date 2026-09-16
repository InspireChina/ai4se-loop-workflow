import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import config from '../../next.config';

function assertBoundary(root: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { assertDesktopArtifactBoundary } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/desktop-artifact-boundary.mjs')).href)};
     await assertDesktopArtifactBoundary(process.argv[1]);`, root], { encoding: 'utf8', timeout: 10000 });
}

test('Next production trace explicitly excludes test helpers and test modules from every standalone entry', () => {
  const excludes = config.outputFileTracingExcludes?.['*'] || [];
  for (const path of ['./src/test/**/*', './src/**/*.test.ts', './src/**/*.test.tsx', './src/**/*.spec.ts']) {
    assert.ok(excludes.includes(path), `Missing trace exclusion ${path}`);
  }
});

test('packaging rejects real fixture files even if the compilation dependency graph never imported them', () => {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'standalone');
  const fixtures = join(root, 'src', 'test');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'legacy-dispatch-planner.ts'), 'Test-only source must not be shipped');
  const protectedRuntime = join(root, 'known-good-runtime.marker');
  writeFileSync(protectedRuntime, 'preserve existing runtime');
  const result = assertBoundary(root);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test-only source.*src\/test/);
  assert.equal(readFileSync(protectedRuntime, 'utf8'), 'preserve existing runtime');
  const builder = readFileSync(join(process.cwd(), 'scripts/build-desktop-runtime.mjs'), 'utf8');
  assert.ok(builder.indexOf('await assertDesktopArtifactBoundary(standaloneRoot)') < builder.indexOf('await rm(outputRoot'),
    'Validate candidate before destroying the existing runtime');
  assert.ok(builder.indexOf('await assertDesktopArtifactBoundary(outputRoot)') > builder.indexOf('const runnerBuild = await build'),
    'Validate the final copied and compiled runtime, not only the input trace');
});

test('the boundary accepts runtime files and third-party package test-named modules but rejects own source tests', () => {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'standalone');
  const dependency = join(root, 'node_modules', 'dependency');
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, 'parser.test.ts'), 'Third-party dependency file');
  writeFileSync(join(root, 'server.js'), 'Actual runtime');
  const clean = assertBoundary(root);
  assert.ifError(clean.error);
  assert.equal(clean.status, 0, clean.stderr);
  mkdirSync(join(root, 'src', 'application'), { recursive: true });
  writeFileSync(join(root, 'src', 'application', 'execution.test.ts'), 'Own test source');
  const dirty = assertBoundary(root);
  assert.ifError(dirty.error);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /execution\.test\.ts/);
});
