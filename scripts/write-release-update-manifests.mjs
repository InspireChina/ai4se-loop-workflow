import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const root = resolve(process.argv[2] || 'release-artifacts');
const version = (process.argv[3] || '').replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: node scripts/write-release-update-manifests.mjs <artifact-directory> <version>');
}

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else result.push(path);
  }
  return result;
}

async function describe(path) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return {
    url: basename(path),
    sha512: hash.digest('base64'),
    size: (await stat(path)).size,
  };
}

function yamlFile(file, indent = '  ') {
  return `${indent}- url: ${file.url}\n${indent}  sha512: ${file.sha512}\n${indent}  size: ${file.size}`;
}

function manifest(files) {
  const primary = files[0];
  return [
    `version: ${version}`,
    'files:',
    ...files.map((file) => yamlFile(file)),
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
}

const allFiles = await filesBelow(root);
const windowsPaths = allFiles.filter((path) => /Setup.*\.exe$/i.test(basename(path)));
const macZipPaths = allFiles.filter((path) => /-mac-(?:arm64|x64)\.zip$/i.test(basename(path))).sort((a, b) => basename(a).localeCompare(basename(b)));

if (windowsPaths.length !== 1) throw new Error(`Expected one Windows Setup EXE, found ${windowsPaths.length}`);
if (macZipPaths.length !== 2) throw new Error(`Expected two architecture-specific macOS ZIP files, found ${macZipPaths.length}`);
if (!macZipPaths.some((path) => basename(path).includes('arm64')) || !macZipPaths.some((path) => basename(path).includes('x64'))) {
  throw new Error('macOS updater ZIP files must include one arm64 and one x64 artifact');
}

const windowsFiles = await Promise.all(windowsPaths.map(describe));
const macFiles = await Promise.all(macZipPaths.map(describe));
await writeFile(join(root, 'latest.yml'), manifest(windowsFiles), 'utf8');
await writeFile(join(root, 'latest-mac.yml'), manifest(macFiles), 'utf8');
console.log(`Wrote updater manifests for Windows and ${macFiles.length} macOS architectures (v${version})`);
