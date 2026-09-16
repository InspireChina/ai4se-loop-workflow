import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { readRepairWorkspaceVersion, workspaceVersionCommand, workspaceVersionLaunch } from './repair-workspace-version';
import { createNativeAdminVerification } from './native-admin-verification';
import { AdminManagementStore } from './admin-management-store';
import { createAdminController } from '../application/admin-controller';

function fixture() {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID(), "owned project's source");
  mkdirSync(root, { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Independent version test']);
  git(['config', 'user.email', 'version@example.invalid']);
  writeFileSync(join(root, 'feature.txt'), 'fixed');
  writeFileSync(join(root, '.gitignore'), '.env*\n.tmp/\n');
  git(['add', '--', 'feature.txt', '.gitignore']);
  git(['commit', '-qm', 'Original source']);
  return { root, git };
}

test('workspace identity is stable and read-only but detects tracked, untracked and staged content without a new commit', async () => {
  const h = fixture();
  const beforeIndex = readFileSync(join(h.root, '.git', 'index'));
  const original = await readRepairWorkspaceVersion(h.root);
  assert.match(original, /^workspace-content-v1:[0-9a-f]{40,64}:[0-9a-f]{64}$/);
  assert.equal(await readRepairWorkspaceVersion(h.root), original);
  assert.deepEqual(readFileSync(join(h.root, '.git', 'index')), beforeIndex, 'No git add/temp index/write-tree during identity reads');
  writeFileSync(join(h.root, 'feature.txt'), 'different content');
  const dirty = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(dirty, original);
  h.git(['add', '--', 'feature.txt']);
  assert.equal(await readRepairWorkspaceVersion(h.root), dirty, 'Index staging alone does not change the executed source');
  const path = process.platform === 'win32' ? '-untracked source.txt' : '-untracked\nsource.txt';
  writeFileSync(join(h.root, path), 'actual new source');
  const added = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(added, dirty);
  writeFileSync(join(h.root, path), 'different new source');
  assert.notEqual(await readRepairWorkspaceVersion(h.root), added, 'Untracked path names are NUL-delimited, not split on lines');
  assert.equal(h.git(['rev-parse', 'HEAD']), original.split(':')[1]);
});

test('assume-unchanged source and ignored runtime configuration cannot hide an actual version change', async () => {
  const h = fixture();
  h.git(['update-index', '--assume-unchanged', 'feature.txt']);
  const original = await readRepairWorkspaceVersion(h.root);
  writeFileSync(join(h.root, 'feature.txt'), 'changed although git status is clean');
  assert.equal(h.git(['status', '--porcelain']), '');
  const changed = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(changed, original);
  const secret = `fixture-secret-${randomUUID()}`;
  writeFileSync(join(h.root, '.env.local'), `API_KEY=${secret}`);
  const configured = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(configured, changed);
  assert.equal(configured.includes(secret), false);
  writeFileSync(join(h.root, '.env.test'), 'TEST_ENDPOINT=actual-test-service');
  const withTestConfiguration = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(withTestConfiguration, configured, 'Capture all root .env variants, not only production or local names');
  mkdirSync(join(h.root, '.tmp'), { recursive: true });
  writeFileSync(join(h.root, '.tmp', 'agent-generated-check.mjs'), 'Temporary test witness');
  assert.equal(await readRepairWorkspaceVersion(h.root), withTestConfiguration, 'Untracked Agent scratch files are not source changes');
  h.git(['add', '-f', '--', '.tmp/agent-generated-check.mjs']);
  assert.notEqual(await readRepairWorkspaceVersion(h.root), withTestConfiguration, 'Tracked files are included even under .tmp');
});

test('unreadable roots, escaping symlinks, cancellation and invalid deadlines never fabricate a version', async () => {
  const h = fixture();
  const plain = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  mkdirSync(plain);
  await assert.rejects(readRepairWorkspaceVersion(plain), /git|Git/);
  await assert.rejects(readRepairWorkspaceVersion(h.root, { timeoutMs: 0 }), /positive/);
  const stopped = new AbortController(); stopped.abort(new Error('User stopped'));
  await assert.rejects(readRepairWorkspaceVersion(h.root, { signal: stopped.signal }), /User stopped/);
  await assert.rejects(readRepairWorkspaceVersion(h.root, { extraPaths: ['../outside'] }), /outside/);
  if (process.platform !== 'win32') {
    const outside = join(process.env.LOOP_DATA_ROOT!, `${randomUUID()}.txt`);
    writeFileSync(outside, 'External file is not owned');
    symlinkSync(outside, join(h.root, 'escaping-source'));
    await assert.rejects(readRepairWorkspaceVersion(h.root), /escapes/);
  }
});

test('internal directory skill aliases include their entire tree, including ignored content, without modifying the index',
  { skip: process.platform === 'win32' ? 'Creating symbolic links requires local Windows privileges' : false }, async () => {
    const h = fixture();
    mkdirSync(join(h.root, '.ai', 'skills', 'example'), { recursive: true });
    mkdirSync(join(h.root, '.claude'));
    writeFileSync(join(h.root, '.ai', 'skills', 'example', 'SKILL.md'), 'Original skill instructions');
    writeFileSync(join(h.root, '.ai', 'skills', 'example', '.env.local'), 'SECRET=fixture-only');
    symlinkSync('../.ai/skills', join(h.root, '.claude', 'skills'), 'dir');
    const index = readFileSync(join(h.root, '.git', 'index'));
    const original = await readRepairWorkspaceVersion(h.root);
    assert.equal(await readRepairWorkspaceVersion(h.root), original);
    writeFileSync(join(h.root, '.ai', 'skills', 'example', '.env.local'), 'SECRET=changed-fixture-only');
    const changed = await readRepairWorkspaceVersion(h.root);
    assert.notEqual(changed, original, 'Ignored files reached through an owned directory alias still affect actual instructions');
    assert.equal(changed.includes('changed-fixture-only'), false);
    writeFileSync(join(h.root, '.ai', 'skills', 'example', 'SKILL.md'), 'Changed actual skill instructions');
    assert.notEqual(await readRepairWorkspaceVersion(h.root), changed);
    assert.deepEqual(readFileSync(join(h.root, '.git', 'index')), index);
  });

test('recursive directory aliases reject cycles and external nested targets instead of fabricating an empty tree version',
  { skip: process.platform === 'win32' ? 'Creating symbolic links requires local Windows privileges' : false }, async () => {
    const cyclic = fixture();
    mkdirSync(join(cyclic.root, 'actual-tree'));
    symlinkSync('actual-tree', join(cyclic.root, 'alias'), 'dir');
    symlinkSync('.', join(cyclic.root, 'actual-tree', 'self'), 'dir');
    await assert.rejects(readRepairWorkspaceVersion(cyclic.root), /cycle/);
    const escaping = fixture();
    mkdirSync(join(escaping.root, 'actual-tree'));
    symlinkSync('actual-tree', join(escaping.root, 'alias'), 'dir');
    const external = join(process.env.LOOP_DATA_ROOT!, randomUUID());
    mkdirSync(external);
    writeFileSync(join(external, 'external.txt'), 'Not owned source');
    symlinkSync(external, join(escaping.root, 'actual-tree', 'external'), 'dir');
    await assert.rejects(readRepairWorkspaceVersion(escaping.root), /escapes/);
  });

test('unsupported actual Git submodule directory entries still fail rather than treating the checkout as empty content', async () => {
  const h = fixture();
  mkdirSync(join(h.root, 'submodule'));
  writeFileSync(join(h.root, 'submodule', 'actual-source.txt'), 'Source tree needs its own Git checkout capability');
  h.git(['update-index', '--add', '--cacheinfo', `160000,${h.git(['rev-parse', 'HEAD'])},submodule`]);
  await assert.rejects(readRepairWorkspaceVersion(h.root), /not a regular file/);
});

test('workspace hashing yields to heartbeat timers while reading actual binary source', async () => {
  const h = fixture();
  writeFileSync(join(h.root, 'large-source.bin'), Buffer.alloc(16 * 1024 * 1024, 123));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    assert.match(await readRepairWorkspaceVersion(h.root), /^workspace-content-v1:/);
    assert.ok(ticks > 0, 'Git identity and hashing must not synchronously starve host renewal');
  } finally { clearInterval(timer); }
});

test('ownership loss cancels an in-flight source read instead of keeping Git or file streams running until the deadline', async () => {
  const h = fixture();
  writeFileSync(join(h.root, 'large-source.bin'), Buffer.alloc(32 * 1024 * 1024, 45));
  let current = true;
  const timer = setTimeout(() => { current = false; }, 10);
  try {
    await assert.rejects(readRepairWorkspaceVersion(h.root, { assertCurrent: () => {
      if (!current) throw new Error('User stopped or ownership changed');
    } }), /User stopped or ownership changed|aborted/i);
  } finally { clearTimeout(timer); }
});

test('an inherited GIT_DIR cannot redirect source identity to a different repository', async () => {
  const h = fixture(); const other = fixture();
  const expected = await readRepairWorkspaceVersion(h.root);
  const prior = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other.root, '.git');
  try { assert.equal(await readRepairWorkspaceVersion(h.root), expected); }
  finally { if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior; }
});

test('the actual bundled installed version command has no business dependency and returns the same fingerprint as the host', async () => {
  const h = fixture();
  const bundleRoot = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  const runners = join(bundleRoot, 'desktop-runners');
  mkdirSync(runners, { recursive: true });
  const result = await build({ entryPoints: ['scripts/loop/workspace-version-entry.ts'],
    outfile: join(runners, 'workspace-version.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', metafile: true, logLevel: 'silent' });
  assert.equal(Object.keys(result.metafile!.inputs).some(path => /(?:database|tasks|interventions|admin-management-store|next|electron)\.(?:ts|js)$/.test(path)), false);
  const launch = workspaceVersionLaunch(bundleRoot, h.root);
  const actual = spawnSync(launch.command, launch.args, { encoding: 'utf8', timeout: 10000 });
  assert.ifError(actual.error);
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(actual.stdout.trim(), await readRepairWorkspaceVersion(h.root));
  assert.match(workspaceVersionCommand(bundleRoot, h.root, 'win32'), /^& /);
  assert.match(workspaceVersionCommand(bundleRoot, h.root, 'win32'), /project''s source/);
  assert.match(workspaceVersionCommand(bundleRoot, h.root, 'darwin'), /project'\\''s source/);
});

for (const mutate of [false, true]) test(`native independent verification uses actual source fingerprint and ${mutate ? 'rejects changes during checks' : 'passes unchanged real checks'}`,
  { skip: process.platform === 'win32' ? 'Independent process-group proof still requires the Windows guardian / Job Object capability' : false }, async () => {
  const h = fixture();
  const version = await readRepairWorkspaceVersion(h.root);
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'manager.db'));
  store.setIntent('running', 'start');
  const repairCase = store.observe({ observationId: 'original', scope: 'runtime', scopeKey: h.root, fingerprint: 'missing',
    sourceVersion: 'original', origin: 'runtime', summary: 'Original behavior must be fixed', evidence: { oracle: 'feature.txt must contain fixed' } });
  const authority = store.acquireSupervisor('host')!;
  const repair = store.claimNext(authority)!;
  const credential = store.issueCommandCredential(repair);
  store.commandStatus(credential);
  store.commandRecordEvidence(credential, 'fix', 'change', { file: 'feature.txt' });
  store.commandSubmit(credential, { outcome: 'verification-requested', summary: 'Check real source', repairVersion: version,
    originalObservationIds: ['original'], repairEvidenceKeys: ['fix'], verification: { reproductionCommand: 'echo fake pass',
      versionCheckCommand: 'echo fake version', acceptanceChecks: [{ targetRef: 'fake', command: 'echo fake', expected: 'fake' }] } });
  store.finishAttempt(repair, { outcome: 'verification-requested', reason: 'Check real source', exitConfirmed: true });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const run = (code: string) => `${quote(process.execPath)} -e ${quote(code)}`;
  const check = run("require('node:assert/strict').equal(require('node:fs').readFileSync('feature.txt','utf8'),'fixed')");
  const plan = { sourceRepairAttemptId: repair.attempt.attemptId, expectedVersion: version, originalObservationIds: ['original'],
    versionCommand: workspaceVersionCommand(process.cwd(), h.root), reproduction: { targetRef: 'original', command: check },
    acceptanceChecks: [{ targetRef: 'original-feature', command: mutate ? run("require('node:fs').writeFileSync('feature.txt','changed during check')") : check }] };
  const controller = createAdminController({ store, ownerId: 'host', confirmStopped: async () => true,
    launch: async () => { throw new Error('Do not rerun the saved repair'); },
    launchVerification: createNativeAdminVerification({ store, appRoot: process.cwd(), resolvePlan: async () => ({ plan, workspaceRoot: h.root }) }) });
  try {
    await controller.reconcile(); await controller.waitForSettlements();
    const attempt = store.attempts(repairCase.caseId).find(row => row.role === 'verification')!;
    const receipt = store.verificationReceipt(attempt.attemptId)!;
    assert.equal(receipt.passed, !mutate);
    assert.equal(receipt.checks[0].result.stdout.trim(), version);
    assert.equal(receipt.checks.at(-1)?.kind, 'version-after');
    assert.equal(store.getCase(repairCase.caseId)?.status, mutate ? 'queued' : 'observing');
    assert.equal(attempt.status, mutate ? 'failed' : 'completed');
    assert.throws(() => process.kill(attempt.pid!, 0), 'The physical verification worker must be reaped');
    if (mutate) assert.notEqual(receipt.checks.at(-1)?.result.stdout.trim(), version);
  } finally { await controller.shutdown(); store.close(); }
});
