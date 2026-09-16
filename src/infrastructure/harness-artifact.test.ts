import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,symlink,chmod,unlink,cp} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {artifactFixture} from '../test/harness-artifact-fixture';
import {readHarnessArtifact,readHarnessSourceBinding,writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';

test('installed artifact content identity binds actual executable bytes, source and build; copying to a new root preserves identity',async()=>{
  const h=await artifactFixture();assert.deepEqual(await readHarnessArtifact(h.root),h.descriptor);
  const manifest=JSON.parse(await readFile(join(h.root,'harness-artifact.json'),'utf8'));
  assert.ok(manifest.files.some((file:{path:string})=>file.path==='desktop-runners/host-service.cjs'));
  assert.ok(manifest.files.some((file:{path:string})=>file.path==='harness-source.json.gz'));
  assert.ok(!manifest.files.some((file:{path:string})=>file.path==='harness-artifact.json'));
  const copy=join(process.env.LOOP_DATA_ROOT!,`artifact-copy-${randomUUID()}`);await cp(h.root,copy,{recursive:true});
  assert.deepEqual(await readHarnessArtifact(copy),{...h.descriptor,root:copy});
  await assert.rejects(writeHarnessArtifact(h.root),/EEXIST/);
});

test('installed artifact detects changed, added, removed and executable-bit changed files, not only a version string',async()=>{
  const h=await artifactFixture();const entry=join(h.root,'desktop-runners','host-service.cjs');
  await writeFile(entry,'tampered bytes');await assert.rejects(readHarnessArtifact(h.root),/installed bytes changed/);
  await writeFile(entry,'actual installed bytes');assert.deepEqual(await readHarnessArtifact(h.root),h.descriptor);
  const extra=join(h.root,'untracked.cjs');await writeFile(extra,'untracked executable');await assert.rejects(readHarnessArtifact(h.root),/installed bytes changed/);await unlink(extra);
  await chmod(entry,0o700);await assert.rejects(readHarnessArtifact(h.root),/installed bytes changed/);await chmod(entry,0o600);
  await unlink(entry);await assert.rejects(readHarnessArtifact(h.root),/installed bytes changed/);
});

test('artifact validation rejects manifest tampering, source/build mismatch, symbolic escapes and cancellation',async()=>{
  const h=await artifactFixture();const filename=join(h.root,'harness-artifact.json');const original=await readFile(filename);
  const manifest=JSON.parse(original.toString());manifest.files[0].path='../outside';await writeFile(filename,JSON.stringify(manifest));
  await assert.rejects(readHarnessArtifact(h.root),/inventory/);await writeFile(filename,original);
  await writeFile(join(h.root,'.next','BUILD_ID'),'different');await assert.rejects(readHarnessArtifact(h.root),/binding mismatch/);await writeFile(join(h.root,'.next','BUILD_ID'),'controlled-build');
  await symlink(join(h.root,'package.json'),join(h.root,'escape.json'));await assert.rejects(readHarnessArtifact(h.root),/Unsafe/);await unlink(join(h.root,'escape.json'));
  const signal=AbortSignal.abort();await assert.rejects(readHarnessArtifact(h.root,{signal}),{name:'AbortError'});
});

test('artifact inventory preserves the exact cancellation reason before and during byte verification',async()=>{
  const h=await artifactFixture();const reason=new Error('user-stop-during-startup');
  await assert.rejects(readHarnessArtifact(h.root,{signal:AbortSignal.abort(reason)}),error=>error===reason);
  const cancellation=new AbortController();let checks=0;
  await assert.rejects(readHarnessArtifact(h.root,{signal:cancellation.signal,assertCurrent:()=>{
    checks++;cancellation.abort(reason);
  }}),error=>error===reason);
  assert.equal(checks,1);
});

test('damaged-image source binding identifies exact source without treating damaged executable bytes as runnable',async()=>{
  const h=await artifactFixture();const before=await readHarnessSourceBinding(h.root);
  assert.equal(before.sourceId,h.descriptor.sourceId);assert.equal(before.version,h.descriptor.version);
  assert.equal(before.declaredArtifactId,h.descriptor.artifactId);assert.equal(before.buildId,'controlled-build');
  await writeFile(join(h.root,'desktop-runners','host-service.cjs'),'damaged executable bytes');
  await assert.rejects(readHarnessArtifact(h.root),/installed bytes changed/);
  assert.deepEqual(await readHarnessSourceBinding(h.root),before,'source provenance is weaker than full runnable identity but remains exact');
  await writeFile(join(h.root,'.next','BUILD_ID'),'unrelated-build');
  await assert.rejects(readHarnessSourceBinding(h.root),/binding mismatch/);
});
