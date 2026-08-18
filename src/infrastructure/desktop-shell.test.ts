import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
  assert.equal(png[25], 6, 'tray PNG must retain RGBA transparency');
});
