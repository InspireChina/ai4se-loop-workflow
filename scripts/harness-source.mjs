import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

// Build inputs, not the operator's checkout as a whole. Tests are archived
// data for isolated repair, never installed as executable runtime modules.
const roots = ['app', 'src', 'scripts', 'desktop', 'command-chains', 'migrations', 'app-migrations'];
const rootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts'];
const extensions = /\.(?:ts|tsx|mjs|cjs|js|json|css|svg|png|yaml|yml|sql|py|sh|md)$/;
const forbidden = /^(?:node_modules|data|tmp|dist|dist-desktop|desktop-runtime|\.next|\.git|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|db|sqlite|log))$/i;
const maxBytes = 256 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function identity(files) {
  return digest(JSON.stringify(files.map(({ path, sha256, executable }) => ({ path, sha256, executable }))));
}
function allowed(path) {
  const segments = path.split('/');
  return segments.every(part => part && part !== '.' && part !== '..' && !forbidden.test(part) && !/[\\:*?"<>|\x00-\x1f]/.test(part)
    && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    && (rootFiles.includes(path) || (roots.includes(segments[0]) && extensions.test(path)));
}

export async function captureHarnessSource(root) {
  const files = []; let total = 0; let inspected = 0;
  async function add(path) {
    const absolute = join(root, path);
    // No symlinks or hardlinks: read-only source must not escape into data or
    // silently capture another checkout. O_NOFOLLOW is not portable; compare
    // the opened descriptor with the preceding path identity instead.
    const before = await lstat(absolute);
    if (!before.isFile() || before.nlink !== 1) throw new Error(`Harness source is not an ordinary private file: ${path}`);
    const handle = await open(absolute, 'r');
    try {
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size > 32 * 1024 * 1024) throw new Error(`Harness source changed or exceeds file limit: ${path}`);
      const bytes = await handle.readFile(); const after = await handle.stat(); const current = await lstat(absolute);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || !current.isFile()) throw new Error(`Harness source changed during capture: ${path}`);
      total += bytes.length;
      if (total > maxBytes || files.length >= 10000) throw new Error('Harness source exceeds bounded archive limits');
      files.push({ path, sha256: digest(bytes), executable: !!(before.mode & 0o111), content: bytes.toString('base64') });
    } finally { await handle.close(); }
  }
  async function walk(prefix) {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      if (++inspected > 20000) throw new Error('Harness source exceeds bounded inventory');
      if (forbidden.test(entry.name)) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Harness source contains symbolic link: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (allowed(path)) await add(path);
    }
  }
  for (const path of rootFiles) await add(path);
  for (const path of roots) {
    const info = await lstat(join(root, path));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Harness source root is not an ordinary directory: ${path}`);
    await walk(path);
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const version = JSON.parse(Buffer.from(files.find(file => file.path === 'package.json').content, 'base64').toString()).version;
  if (typeof version !== 'string' || !version) throw new Error('Harness source lacks package version');
  return { schema: 1, sourceId: identity(files), version, files };
}

export function encodeHarnessSource(source, build) {
  return gzipSync(Buffer.from(JSON.stringify({ ...source, build })), { level: 9 });
}

export function decodeHarnessSource(bytes) {
  if (bytes.length > maxBytes) throw new Error('Harness source compressed archive exceeds limit');
  const source = JSON.parse(gunzipSync(bytes, { maxOutputLength: maxBytes * 1.5 }).toString('utf8'));
  if (source.schema !== 1 || !Array.isArray(source.files) || source.files.length > 10000 || !source.files.length) throw new Error('Invalid Harness source manifest');
  let total = 0; let previous = '';
  for (const file of source.files) {
    if (typeof file.path !== 'string' || !allowed(file.path) || file.path <= previous || typeof file.executable !== 'boolean'
      || typeof file.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new Error('Unsafe or duplicate Harness source entry');
    const content = Buffer.from(file.content, 'base64'); total += content.length;
    if (content.length > 32 * 1024 * 1024 || total > maxBytes || digest(content) !== file.sha256) throw new Error(`Harness source content mismatch: ${file.path}`);
    previous = file.path;
  }
  for (const path of rootFiles) if (!source.files.some(file => file.path === path)) throw new Error(`Harness source missing build input: ${path}`);
  const version = JSON.parse(Buffer.from(source.files.find(file => file.path === 'package.json').content, 'base64').toString()).version;
  if (source.sourceId !== identity(source.files) || source.version !== version) throw new Error('Harness source identity mismatch');
  if (!source.build || typeof source.build.buildId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(source.build.buildId)) throw new Error('Harness source lacks successful build binding');
  return source;
}

export async function assertHarnessBuildSource(root) {
  const bytes = await readFile(join(root, '.next', 'harness-source.json.gz'));
  const source = decodeHarnessSource(bytes);
  const current = await captureHarnessSource(root);
  const buildId = (await readFile(join(root, '.next', 'BUILD_ID'), 'utf8')).trim();
  if (current.sourceId !== source.sourceId || buildId !== source.build.buildId) throw new Error('Harness build is stale: source or Next build identity changed; run npm run build again');
  return { source, bytes };
}

/** Caller provides a NEW private workspace; never overwrite existing files,
 * follow existing parent symlinks, or extract into the installed runtime. */
export async function extractHarnessSource(bytes, destination, options = {}) {
  const check=()=>{options.signal?.throwIfAborted();options.assertCurrent?.();};check();
  const source = decodeHarnessSource(bytes);
  check();await mkdir(destination, { mode: 0o700 });check(); // exclusive directory creation
  for (const root of roots) {check();await mkdir(join(destination, root), { mode: 0o700 });check();}
  for (const file of source.files) {
    check();
    const path = join(destination, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });check();
    await writeFile(path, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
    check();
  }
  return { sourceId: source.sourceId, version: source.version, buildId: source.build.buildId };
}
