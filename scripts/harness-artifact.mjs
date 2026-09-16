import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decodeHarnessSource } from './harness-source.mjs';

const manifestFile = 'harness-artifact.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = files => hash(JSON.stringify(files));
const safePath = path => typeof path === 'string' && path.split('/').every(part => part && part !== '.' && part !== '..'
  && !/[\\:*?"<>|\x00-\x1f]/.test(part) && !/[. ]$/.test(part));

async function readStableFile(root, path, maxBytes, options = {}) {
  const check = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  check();
  let parent = root;
  for (const segment of path.split('/').slice(0, -1)) {
    parent = join(parent, segment);
    const info = await lstat(parent); check();
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Harness binding parent: ${path}`);
  }
  const filename = join(root, path); const before = await lstat(filename); check();
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error(`Invalid Harness binding file: ${path}`);
  }
  const handle = await open(filename, 'r');
  try {
    const opened = await handle.stat(); check();
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error(`Harness binding changed while opening: ${path}`);
    const bytes = await handle.readFile(); check();
    const after = await handle.stat(); const current = await lstat(filename); check();
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.ino !== before.ino || current.dev !== before.dev
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`Harness binding changed while reading: ${path}`);
    }
    return bytes;
  } finally { await handle.close(); }
}

/** Read source/build provenance without trusting or executing the remaining
 * installed bytes. This is deliberately weaker than readHarnessArtifact: it
 * may identify the exact source of a damaged image, but never proves that
 * image runnable or authorizes it as a candidate. */
export async function readHarnessSourceBinding(root, options = {}) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const actualRoot = await realpath(root); const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Harness source binding root must be an ordinary directory');
  const [archive, packageBytes, buildBytes, manifestBytes] = await Promise.all([
    readStableFile(actualRoot, 'harness-source.json.gz', 256 * 1024 * 1024, options),
    readStableFile(actualRoot, 'package.json', 4 * 1024 * 1024, options),
    readStableFile(actualRoot, '.next/BUILD_ID', 4096, options),
    readStableFile(actualRoot, manifestFile, 32 * 1024 * 1024, options),
  ]);
  const source = decodeHarnessSource(archive);
  const version = JSON.parse(packageBytes.toString('utf8')).version;
  const buildId = buildBytes.toString('utf8').trim();
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (typeof version !== 'string' || !version || source.version !== version || source.build.buildId !== buildId
    || manifest?.schema !== 1 || manifest.sourceId !== source.sourceId || manifest.version !== version
    || manifest.buildId !== buildId || typeof manifest.artifactId !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.artifactId)) {
    throw new Error('Harness damaged-image source/build binding mismatch');
  }
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  return { root: actualRoot, sourceId: source.sourceId, version, buildId,
    declaredArtifactId: manifest.artifactId, archiveHash: hash(archive) };
}

/** Installed bytes, including native modules and compiled runners, not only
 * package.version or source hashes. No symlink traversal / PID assumptions. */
async function inventory(root, options = {}) {
  const files = []; let total = 0; const deadline = Date.now() + 120000;
  function check() {
    options.signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error('Harness artifact inventory timed out');
    options.assertCurrent?.();
  }
  async function walk(prefix) {
    check();
    for (const entry of await readdir(join(root,prefix),{withFileTypes:true})) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === manifestFile) continue;
      if (!safePath(path) || entry.isSymbolicLink()) throw new Error(`Unsafe installed Harness entry: ${path}`);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile() || files.length >= 100000) throw new Error('Harness artifact inventory exceeds file limit');
      const filename = join(root,path); const before = await lstat(filename);
      if (!before.isFile() || before.nlink !== 1 || before.size > 512*1024*1024) throw new Error(`Invalid Harness artifact file: ${path}`);
      total += before.size; if (total > 2*1024*1024*1024) throw new Error('Harness artifact exceeds byte limit');
      const descriptor = await open(filename,'r');
      try {
        const opened = await descriptor.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('Harness artifact changed while opening');
        const digest = createHash('sha256');
        for await (const chunk of descriptor.createReadStream({autoClose:false})) { check(); digest.update(chunk); }
        const after = await descriptor.stat(); const current = await lstat(filename);
        if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`Harness artifact changed during inventory: ${path}`);
        files.push({path,sha256:digest.digest('hex'),executable:!!(before.mode&0o111)});
      } finally { await descriptor.close(); }
    }
  }
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Harness artifact root must be an ordinary directory');
  await walk(''); files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0); check(); return files;
}

export async function writeHarnessArtifact(root) {
  const source = decodeHarnessSource(await readFile(join(root,'harness-source.json.gz')));
  const files = await inventory(root);
  const manifest = {schema:1,artifactId:identity(files),sourceId:source.sourceId,version:source.version,buildId:source.build.buildId,files};
  await writeFile(join(root,manifestFile),JSON.stringify(manifest),{flag:'wx',mode:0o600});
  await readHarnessArtifact(root);
  return {root:resolve(root),sourceId:manifest.sourceId,artifactId:manifest.artifactId,version:manifest.version};
}

export async function readHarnessArtifact(root, options = {}) {
  options.signal?.throwIfAborted();
  const bytes = await readFile(join(root,manifestFile)); if (bytes.length > 32*1024*1024) throw new Error('Harness manifest exceeds limit');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000) throw new Error('Invalid Harness artifact manifest');
  let previous = '';
  for (const file of manifest.files) {
    if (!safePath(file.path) || file.path === manifestFile || file.path <= previous || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.executable !== 'boolean') throw new Error('Invalid Harness artifact inventory');
    previous = file.path;
  }
  if (identity(manifest.files) !== manifest.artifactId) throw new Error('Harness artifact manifest identity mismatch');
  const source = decodeHarnessSource(await readFile(join(root,'harness-source.json.gz')));
  const version = JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
  const buildId = (await readFile(join(root,'.next','BUILD_ID'),'utf8')).trim();
  if (source.sourceId !== manifest.sourceId || source.version !== manifest.version || version !== manifest.version || buildId !== manifest.buildId || buildId !== source.build.buildId) throw new Error('Harness installed/source/build binding mismatch');
  const actual = await inventory(root,options);
  if (identity(actual) !== manifest.artifactId) throw new Error('Harness installed bytes changed; reject candidate');
  return {root:resolve(root),sourceId:manifest.sourceId,artifactId:manifest.artifactId,version:manifest.version};
}
