import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('keeps root and desktop release manifests on one version', async () => {
  const [rootPackage, rootLock, desktopPackage, desktopLock] = await Promise.all([
    readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../desktop/package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../desktop/package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const expected = rootPackage.version;
  assert.equal(rootLock.version, expected);
  assert.equal(rootLock.packages[''].version, expected);
  assert.equal(desktopPackage.version, expected);
  assert.equal(desktopLock.version, expected);
  assert.equal(desktopLock.packages[''].version, expected);
});

test('rejects updater manifests when packaged artifact names use another version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loopwork-release-version-'));
  try {
    await writeFile(join(directory, 'LoopWork-0.1.15-windows-x64-Setup.exe'), 'stale');
    await assert.rejects(
      execFileAsync(process.execPath, [
        new URL('../../scripts/write-release-update-manifests.mjs', import.meta.url).pathname,
        directory,
        'v0.1.17',
      ]),
      /Release artifacts do not match v0\.1\.17/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writes updater manifests only for artifacts carrying the release version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loopwork-release-version-'));
  try {
    await Promise.all([
      writeFile(join(directory, 'LoopWork-0.1.17-windows-x64-Setup.exe'), 'windows'),
      writeFile(join(directory, 'LoopWork-0.1.17-mac-arm64.zip'), 'arm64'),
      writeFile(join(directory, 'LoopWork-0.1.17-mac-x64.zip'), 'x64'),
    ]);
    await execFileAsync(process.execPath, [
      new URL('../../scripts/write-release-update-manifests.mjs', import.meta.url).pathname,
      directory,
      'v0.1.17',
    ]);
    const [windowsManifest, macManifest] = await Promise.all([
      readFile(join(directory, 'latest.yml'), 'utf8'),
      readFile(join(directory, 'latest-mac.yml'), 'utf8'),
    ]);
    assert.match(windowsManifest, /^version: 0\.1\.17/m);
    assert.match(windowsManifest, /LoopWork-0\.1\.17-windows-x64-Setup\.exe/);
    assert.match(macManifest, /^version: 0\.1\.17/m);
    assert.match(macManifest, /LoopWork-0\.1\.17-mac-arm64\.zip/);
    assert.match(macManifest, /LoopWork-0\.1\.17-mac-x64\.zip/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
