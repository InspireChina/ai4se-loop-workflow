import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import type {RuntimeArtifact} from '../domain/runtime-update';

export function workspaceVersionLaunch(appRoot: string, workspaceRoot: string) {
  const bundled = join(appRoot, 'desktop-runners', 'workspace-version.cjs');
  return { command: process.env.LOOP_DESKTOP_NODE || process.execPath,
    args: [...(existsSync(bundled) ? [bundled] : ['--import', pathToFileURL(join(appRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      join(appRoot, 'scripts', 'loop', 'workspace-version-entry.ts')]), '--workspace-root', workspaceRoot] };
}
export function workspaceVersionCommand(appRoot: string, workspaceRoot: string, platform: NodeJS.Platform = process.platform) {
  const launch = workspaceVersionLaunch(appRoot, workspaceRoot);
  return versionLaunchCommand(launch,platform);
}
function versionLaunchCommand(launch:{command:string;args:string[]},platform:NodeJS.Platform) {
  const quote = platform === 'win32' ? (value: string) => `'${value.replaceAll("'", "''")}'`
    : (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${platform === 'win32' ? '& ' : ''}${[launch.command, ...launch.args].map(quote).join(' ')}`;
}
export function runtimeArtifactVersionCommand(appRoot:string,artifact:RuntimeArtifact,platform:NodeJS.Platform=process.platform) {
  const launch=workspaceVersionLaunch(appRoot,artifact.root);
  launch.args.splice(-2,2,'--runtime-artifact',JSON.stringify(artifact));
  return versionLaunchCommand(launch,platform);
}
export async function readRuntimeArtifactVersion(artifact:RuntimeArtifact,options:{signal?:AbortSignal;assertCurrent?:()=>void}={}) {
  const actual=await readHarnessArtifact(artifact.root,options);
  if(JSON.stringify(actual)!==JSON.stringify(artifact))throw new Error('runtime 实际候选与宿主绑定身份不一致');
  return actual.artifactId;
}

/** This identifies source contents, not a running server. A service repair
 * still needs an independent check of the actual endpoint/service version. */
export async function readRepairWorkspaceVersion(workspaceRoot: string, options: {
  signal?: AbortSignal; timeoutMs?: number; extraPaths?: string[]; assertCurrent?: () => void;
} = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Workspace version timeout must be positive');
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => cancellation.abort(new Error('Workspace version read timed out')), timeoutMs);
  const guardTimer = options.assertCurrent ? setInterval(() => {
    if (cancellation.signal.aborted) return;
    try { options.assertCurrent!(); } catch (error) { cancellation.abort(error); }
  }, 100) : undefined;
  const signal = cancellation.signal;
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  // Identity must describe the provided workspace, not an inherited temporary
  // Git index or another repository injected by a previous execution.
  for (const key of Object.keys(environment)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_(?:KEY|VALUE)_\d+)$/.test(key)) {
    delete environment[key as keyof typeof environment];
  }
  try {
    signal.throwIfAborted();
    options.assertCurrent?.();
    const root = await realpath(resolve(workspaceRoot));
    const git = (args: string[]) => new Promise<Buffer>((accept, reject) => {
      execFile('git', args, { cwd: root, encoding: 'buffer', env: environment, signal, windowsHide: true,
        maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : accept(stdout));
    });
    const head = async () => {
      const value = (await git(['rev-parse', '--verify', 'HEAD'])).toString('utf8').trim();
      if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error('Workspace has no valid committed Git identity');
      return value;
    };
    const list = async () => {
      const tracked = await git(['ls-files', '--cached', '-z', '--', '.']);
      const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
      const paths = (value: Buffer) => {
        const text = value.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(value)) throw new Error('Workspace path is not valid UTF-8');
        return text.split('\0').filter(Boolean);
      };
      const included = new Set([...paths(tracked), ...paths(untracked).filter(path => !path.startsWith('.tmp/'))]);
      // Common ignored runtime configuration can affect execution even though
      // git status is clean. Hash it, never log its secret contents.
      const configurationPaths = options.extraPaths ?? (await readdir(root))
        .filter(path => path === '.env' || path.startsWith('.env.') || path === '.envrc');
      for (const path of configurationPaths) {
        assertContained(root, path);
        try { await lstat(join(root, path)); included.add(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const directories = new Set<string>();
      const expandDirectory = async (path: string, ancestors: Set<string>) => {
        signal.throwIfAborted();
        const destination = await realpath(join(root, path));
        assertDestinationContained(root, destination, path);
        if (ancestors.has(destination)) throw new Error(`Workspace directory link cycle: ${path}`);
        directories.add(path);
        const nextAncestors = new Set([...ancestors, destination]);
        for (const entry of await readdir(destination, { withFileTypes: true })) {
          signal.throwIfAborted();
          const child = `${path}/${entry.name}`;
          included.add(child);
          if (included.size > 100000) throw new Error('Workspace identity exceeds 100000 source paths');
          if (entry.isDirectory() || entry.isSymbolicLink() && (await stat(join(root, child))).isDirectory()) {
            await expandDirectory(child, nextAncestors);
          }
        }
      };
      // Internal directory aliases are common (.claude/skills -> .ai/skills).
      // Hash the entire referenced tree, including ignored files, not only the
      // link spelling. Ordinary Git directory entries remain unsupported
      // submodules; do not silently turn their checkout into an empty file.
      for (const path of [...included]) {
        let source;
        try { source = await lstat(join(root, path)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (source.isSymbolicLink() && (await stat(join(root, path))).isDirectory()) {
          await expandDirectory(path, new Set([root]));
        }
      }
      if (included.size > 100000) throw new Error('Workspace identity exceeds 100000 source paths');
      return { paths: [...included].sort(), directories };
    };
    const fingerprint = async ({ paths, directories }: Awaited<ReturnType<typeof list>>) => {
      const facts = new Array<string>(paths.length);
      let cursor = 0;
      const inspect = async () => {
        while (cursor < paths.length) {
          signal.throwIfAborted();
          const index = cursor++;
          const path = paths[index];
          assertContained(root, path);
          const absolute = join(root, path);
          let before: Awaited<ReturnType<typeof lstat>>;
          try { before = await lstat(absolute); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            facts[index] = JSON.stringify([path, 'deleted']);
            continue;
          }
          const destination = await realpath(absolute);
          assertDestinationContained(root, destination, path);
          const targetBefore = await stat(destination);
          // Directories (including Git submodules) need their own version
          // capability. Never treat an unread source tree as an empty file.
          const directory = targetBefore.isDirectory() && directories.has(path);
          if (!targetBefore.isFile() && !directory) throw new Error(`Workspace source is not a regular file: ${path}`);
          const link = before.isSymbolicLink() ? await readlink(absolute) : null;
          const digest = createHash('sha256');
          if (!directory) {
            const stream = createReadStream(destination, { signal });
            for await (const chunk of stream) digest.update(chunk);
          }
          const after = await lstat(absolute);
          const targetAfter = await stat(destination);
          if (!sameFile(before, after) || !sameFile(targetBefore, targetAfter)
            || link !== (after.isSymbolicLink() ? await readlink(absolute) : null)) {
            throw new Error(`Workspace source changed while being read: ${path}`);
          }
          facts[index] = JSON.stringify([path, directory ? 'directory-tree' : link === null ? 'file' : 'symlink', before.mode & 0o777,
            targetBefore.mode & 0o777, link, digest.digest('hex')]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(16, paths.length) }, inspect));
      return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    };
    const startHead = await head();
    const firstPaths = await list();
    const first = await fingerprint(firstPaths);
    const secondPaths = await list();
    if (JSON.stringify(firstPaths.paths) !== JSON.stringify(secondPaths.paths)
      || JSON.stringify([...firstPaths.directories].sort()) !== JSON.stringify([...secondPaths.directories].sort())) {
      throw new Error('Workspace file set changed during version read');
    }
    const second = await fingerprint(secondPaths);
    if (first !== second || await head() !== startHead) throw new Error('Workspace source version changed during version read');
    signal.throwIfAborted();
    options.assertCurrent?.();
    return `workspace-content-v1:${startHead}:${first}`;
  } catch (error) {
    cancellation.abort(error); // stop outstanding streams/Git calls on any failure
    throw error;
  } finally {
    clearTimeout(timer);
    if (guardTimer) clearInterval(guardTimer);
    options.signal?.removeEventListener('abort', abort);
  }
}

function assertContained(root: string, path: string) {
  const relation = relative(root, resolve(root, path));
  if (!path || isAbsolute(path) || !relation || relation === '..'
    || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) {
    throw new Error('Workspace source path is outside the owned root');
  }
}
function assertDestinationContained(root: string, destination: string, path: string) {
  const relation = relative(root, destination);
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) {
    throw new Error(`Workspace source escapes the owned root: ${path}`);
  }
}
function sameFile(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
