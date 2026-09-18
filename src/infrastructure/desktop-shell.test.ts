import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import {artifactFixture} from '../test/harness-artifact-fixture';
import {installDesktopRuntimeImages} from '../../desktop/after-pack.mjs';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';

test('packages a visible tray asset and restores the hidden single-instance window', async () => {
  const [mainSource, manifestSource, png] = await Promise.all([
    readFile(new URL('../../desktop/main.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../desktop/package.json', import.meta.url), 'utf8'),
    readFile(new URL('../../desktop/assets/tray-icon.png', import.meta.url)),
  ]);
  const manifest = JSON.parse(manifestSource) as { build?: { files?: string[] } };

  assert.match(mainSource, /nativeImage\.createFromPath\(join\(app\.getAppPath\(\), 'assets', 'tray-icon\.png'\)\)/);
  assert.match(mainSource, /app\.on\('second-instance', \(\) => \{\s*showMainWindow\(\);\s*\}\)/);
  assert.ok(manifest.build?.files?.includes('assets/**/*'));
  assert.ok(manifest.build?.files?.includes('runtime-fallback.mjs'));
  assert.match(mainSource,/runtimeFallbackDocument/);
  assert.ok(manifest.build?.files?.includes('runtime-host.mjs'));
  assert.match(mainSource,/Promise\.allSettled\(\[lifecycle\?\.shutdown\(\)\]\)/);
  assert.doesNotMatch(mainSource,/prepareDesktopRuntimeInstall/);
  assert.match(mainSource,/await lifecycle\.shutdown\(\)\.catch/,
    'publisher update stops the current runtime best-effort and lets the installed runtime win on restart');
  assert.match(mainSource,/startDesktopRuntimeUi\(lifecycle,availablePort\)/,
    'UI admission must wait for startup without requiring the business host to own the lease');
  assert.doesNotMatch(mainSource,/state\s*!==\s*['"]hosting['"]/,
    'Recoverable lifecycle states must not block the desktop control UI');
  assert.doesNotMatch(mainSource,/await lifecycle\.ready;\s*const state=await lifecycle\.reconcile\(\)/,
    'UI admission must not immediately repeat a completed startup reconciliation');
  assert.match(mainSource,/if\(!lifecycle\)return \{initializing:true,message:'运行宿主正在初始化'\};/,
    'The visible initialization page must receive an explicit status before the host is published');
  assert.ok(mainSource.indexOf('await createWindow();') < mainSource.indexOf('lifecycle=await initializing;'),
    'The initializing window must be visible while the first packaged runtime is staged');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
  assert.equal(png[25], 6, 'tray PNG must retain RGBA transparency');
});

test('desktop packages a physically independent management image and loads recovery code from it',async()=>{
  const source=await artifactFixture('independent desktop image');
  const resources=join(process.env.LOOP_DATA_ROOT!,`desktop-images-${randomUUID()}`);await mkdir(resources,{recursive:true});
  const copied=await installDesktopRuntimeImages(source.root,resources);
  assert.equal(copied.installed.artifactId,copied.management.artifactId);
  assert.notEqual(copied.installed.root,copied.management.root);
  await writeFile(join(copied.installed.root,'desktop-runners','host-service.cjs'),'damaged selected business image');
  await assert.rejects(readHarnessArtifact(copied.installed.root),/installed bytes changed/);
  assert.deepEqual(await readHarnessArtifact(copied.management.root),copied.management);
  const mainSource=await readFile(new URL('../../desktop/main.mjs',import.meta.url),'utf8');
  assert.match(mainSource,/management-bootstrap/);
  assert.match(mainSource,/createRequire\(join\(managementRoot, 'package\.json'\)\)/);
  assert.match(mainSource,/appRoot: root, managementRoot/);
});
