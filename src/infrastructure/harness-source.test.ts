import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

function run(program: string) {
  const root = join(process.env.LOOP_DATA_ROOT!, `harness-source-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const module = pathToFileURL(join(process.cwd(), 'scripts', 'harness-source.mjs')).href;
  const prelude = `import assert from 'node:assert/strict';
    import {mkdir,writeFile,readFile,symlink,link} from 'node:fs/promises';import {join} from 'node:path';
    import {gzipSync} from 'node:zlib';
    import {captureHarnessSource,encodeHarnessSource,decodeHarnessSource,assertHarnessBuildSource,extractHarnessSource} from ${JSON.stringify(module)};
    const root=process.argv[1];
    for(const dir of ['app','src','scripts','desktop','command-chains','migrations','app-migrations'])await mkdir(join(root,dir));
    for(const file of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(root,file),file==='package.json'?JSON.stringify({version:'fixture-v1'}):'{}');
    await writeFile(join(root,'src','actual.ts'),'actual source');
    await writeFile(join(root,'src','actual.test.ts'),'independent repair test');
    await writeFile(join(root,'migrations','001.sql'),'CREATE TABLE actual (id INTEGER);');
    await writeFile(join(root,'command-chains','agent.yaml'),'terminal: submit');
    const build={buildId:'actual-build-id'};
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', prelude + program, root], { encoding: 'utf8', timeout: 20000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return { root, stdout: result.stdout };
}

test('repair source archive preserves dirty actual bytes, tests, contracts and migration inputs, not local data', () => {
  run(`await mkdir(join(root,'data'));await writeFile(join(root,'data','loop-ui.db'),'production data');
    await writeFile(join(root,'.env.local'),'credential');await writeFile(join(root,'src','.env.local'),'nested credential');
    await writeFile(join(root,'src','private.key'),'private key');await mkdir(join(root,'desktop','node_modules'));
    await writeFile(join(root,'desktop','node_modules','secret.json'),'dependency is not source');
    const a=await captureHarnessSource(root);const b=decodeHarnessSource(encodeHarnessSource(a,build));
    assert.deepEqual(a.files,b.files);assert.ok(b.files.some(f=>f.path==='src/actual.test.ts'));
    assert.ok(b.files.some(f=>f.path==='migrations/001.sql'));assert.ok(b.files.some(f=>f.path==='command-chains/agent.yaml'));
    assert.ok(!b.files.some(f=>/credential|private|node_modules|data|env/.test(f.path)));
    await writeFile(join(root,'src','actual.ts'),'dirty changed source');const c=await captureHarnessSource(root);
    assert.notEqual(a.sourceId,c.sourceId);await writeFile(join(root,'src','actual.ts'),'actual source');
    assert.equal(a.sourceId,(await captureHarnessSource(root)).sourceId);`);
});

test('source archive validates content, version, ordering and safe paths before extraction', () => {
  run(`const a=await captureHarnessSource(root);const base={...a,build};
    function reject(change){const b=structuredClone(base);change(b);assert.throws(()=>decodeHarnessSource(gzipSync(Buffer.from(JSON.stringify(b)))));}
    reject(b=>b.files[0].content=Buffer.from('tampered').toString('base64'));
    reject(b=>b.sourceId='fake');reject(b=>b.version='other');reject(b=>b.files.push(b.files[0]));
    reject(b=>b.files[0].path='../data/loop-ui.db');reject(b=>b.files[0].path='src/../../secret.ts');
    reject(b=>b.files[0].path='src/evil\\\\file.ts');reject(b=>b.files[0].content='*invalid-base64*');
    reject(b=>b.files[0].path='src/file.ts:secret');reject(b=>b.files[0].path='src/CON.ts');
    reject(b=>b.build.buildId='../../fake');reject(b=>b.files=b.files.filter(f=>f.path!=='package-lock.json'));
    assert.throws(()=>decodeHarnessSource(Buffer.from('not gzip')));`);
});

test('source capture rejects symlink and hardlink escapes into foreign workspaces', () => {
  run(`const foreign=join(root,'foreign.ts');await writeFile(foreign,'protected');
    await symlink(foreign,join(root,'src','linked.ts'));
    await assert.rejects(captureHarnessSource(root),/symbolic link/);
    assert.equal(await readFile(foreign,'utf8'),'protected');`);
  run(`await link(join(root,'src','actual.ts'),join(root,'src','linked.ts'));
    await assert.rejects(captureHarnessSource(root),/ordinary private file/);`);
});

test('extraction is exclusive and preserves original bytes without rewriting installed/runtime data', () => {
  run(`const a=await captureHarnessSource(root);const archive=encodeHarnessSource(a,build);
    const destination=join(root,'new-private-workspace');const result=await extractHarnessSource(archive,destination);
    assert.equal(result.sourceId,a.sourceId);assert.equal(await readFile(join(destination,'src','actual.test.ts'),'utf8'),'independent repair test');
    assert.equal((await captureHarnessSource(destination)).sourceId,a.sourceId);
    await writeFile(join(destination,'src','actual.ts'),'operator changes');
    await assert.rejects(extractHarnessSource(archive,destination),/EEXIST/);
    assert.equal(await readFile(join(destination,'src','actual.ts'),'utf8'),'operator changes');
    await symlink(destination,join(root,'workspace-alias'));
    await assert.rejects(extractHarnessSource(archive,join(root,'workspace-alias')),/EEXIST/);`);
});

test('Desktop packaging refuses stale source and mismatched successful Next build identities before replacing output', () => {
  const { root } = run(`const a=await captureHarnessSource(root);await mkdir(join(root,'.next'));
    await writeFile(join(root,'.next','BUILD_ID'),build.buildId);
    await writeFile(join(root,'.next','harness-source.json.gz'),encodeHarnessSource(a,build));
    assert.equal((await assertHarnessBuildSource(root)).source.sourceId,a.sourceId);
    await writeFile(join(root,'src','actual.ts'),'changed after build');
    await assert.rejects(assertHarnessBuildSource(root),/stale/);
    await writeFile(join(root,'src','actual.ts'),'actual source');await writeFile(join(root,'.next','BUILD_ID'),'different-build');
    await assert.rejects(assertHarnessBuildSource(root),/stale/);`);
  writeFileSync(join(root, 'known-good-runtime'), 'preserved');
  const builder = readFileSync(join(process.cwd(), 'scripts/build-desktop-runtime.mjs'), 'utf8');
  assert.ok(builder.indexOf('await assertHarnessBuildSource(projectRoot)') < builder.indexOf('await rm(outputRoot'));
  assert.equal(readFileSync(join(root, 'known-good-runtime'), 'utf8'), 'preserved');
});

test('external source CLI checks actual installed version/build and rejects overwriting or extracting into the runtime', () => {
  const { root } = run(`const a=await captureHarnessSource(root);await mkdir(join(root,'.next'));
    await writeFile(join(root,'.next','BUILD_ID'),build.buildId);
    await writeFile(join(root,'harness-source.json.gz'),encodeHarnessSource(a,build));`);
  const workspace = join(process.env.LOOP_DATA_ROOT!, `external-source-${randomUUID()}`);
  const cli = join(process.cwd(), 'scripts', 'harness-source-cli.mjs');
  const call = (destination: string) => spawnSync(process.execPath, [cli, '--runtime-root', root, '--workspace', destination], { encoding: 'utf8', timeout: 20000 });
  const result = call(workspace);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, 'fixture-v1');
  assert.equal(readFileSync(join(workspace, 'src', 'actual.ts'), 'utf8'), 'actual source');
  assert.equal(call(workspace).status, 1);
  const inside = join(root, 'must-not-extract');
  assert.match(call(inside).stderr, /outside the installed runtime/); assert.equal(existsSync(inside), false);
  writeFileSync(join(root, '.next', 'BUILD_ID'), 'different-version');
  const mismatched = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  assert.match(call(mismatched).stderr, /does not match/); assert.equal(existsSync(mismatched), false);
});
