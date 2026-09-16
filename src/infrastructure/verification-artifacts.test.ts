import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, symlink, link, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertVerificationArtifacts, readVerificationArtifacts } from './verification-artifacts';

async function fixture() {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  const directory = join(root, '.tmp', 'independent-test');
  await mkdir(join(directory, 'imports'), { recursive: true });
  await writeFile(join(directory, 'check.js'), 'require("./imports/oracle.json")');
  await writeFile(join(directory, 'imports', 'oracle.json'), '{"expected":"actual"}');
  const options = { workspaceRoot: root, signal: new AbortController().signal };
  return { root, directory: await realpath(directory), options };
}

test('artifact freeze includes imports and data, streams large files, and never edits originals', async () => {
  const h = await fixture();
  await writeFile(join(h.directory, 'large-data.bin'), Buffer.alloc(2 * 1024 * 1024, 42));
  const manifest = await readVerificationArtifacts(h.directory, h.options);
  assert.deepEqual(manifest.entries.map(entry => entry.path), ['', 'check.js', 'imports', 'imports/oracle.json', 'large-data.bin']);
  assert.ok(manifest.entries.filter(entry => entry.kind === 'file').every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)));
  await assertVerificationArtifacts(manifest, h.options);
  await writeFile(join(h.directory, 'imports', 'oracle.json'), '{"expected":"fake"}');
  await assert.rejects(assertVerificationArtifacts(manifest, h.options), /冻结.*修改/);
  assert.equal(await readFile(join(h.directory, 'check.js'), 'utf8'), 'require("./imports/oracle.json")');
});

test('artifact freeze rejects nested symlinks and hardlinks rather than trusting paths in commands', async () => {
  const h = await fixture();
  await symlink(join(h.directory, 'imports', 'oracle.json'), join(h.directory, 'linked.json'));
  await assert.rejects(readVerificationArtifacts(h.directory, h.options), /链接/);
  const hard = await fixture();
  await link(join(hard.directory, 'imports', 'oracle.json'), join(hard.directory, 'linked.json'));
  await assert.rejects(readVerificationArtifacts(hard.directory, hard.options), /链接/);
});

test('artifact collection stops on lost authority and cancellation without authorizing a partial tree', async () => {
  const h = await fixture();
  let visits = 0;
  await assert.rejects(readVerificationArtifacts(h.directory, { ...h.options,
    assertCurrent: () => { if (++visits === 3) throw new Error('Fenced owner'); } }), /Fenced owner/);
  const cancellation = new AbortController(); cancellation.abort(new Error('User stopped'));
  await assert.rejects(readVerificationArtifacts(h.directory, { ...h.options, signal: cancellation.signal }), /User stopped/);
});
