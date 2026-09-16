import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { VerificationArtifactManifest } from '../domain/verification-artifacts';

/** Freeze the entire generated input tree, not just scripts mentioned in a
 * shell string. Imports, data files and the original facts are inputs too.
 * No link traversal or unbounded materialization of file contents. */
export async function readVerificationArtifacts(directory: string, options: {
  workspaceRoot: string; signal: AbortSignal; assertCurrent?: () => void;
}): Promise<VerificationArtifactManifest> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30000)]);
  const check = () => { signal.throwIfAborted(); options.assertCurrent?.(); };
  check();
  const root = await realpath(options.workspaceRoot);
  const canonical = await realpath(directory);
  const location = relative(root, canonical);
  if (!location.startsWith(`.tmp${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(location)
    || canonical !== directory || (await lstat(directory)).isSymbolicLink()) throw new Error('独立验收输入目录越界或被替换为链接');
  const scan = async () => {
    const entries: VerificationArtifactManifest['entries'] = [];
    let bytes = 0;
    const visit = async (path: string, name: string) => {
      check();
      const before = await lstat(path);
      if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()) || (before.isFile() && before.nlink !== 1)) {
        throw new Error('独立验收输入不能包含链接或特殊文件');
      }
      if (entries.length >= 10000) throw new Error('独立验收输入文件数量超过有界读取容量');
      const entry = { path: name, kind: before.isFile() ? 'file' as const : 'directory' as const,
        mode: before.mode, size: before.isFile() ? before.size : 0, sha256: '' };
      entries.push(entry);
      if (before.isDirectory()) {
        const names: string[] = [];
        for await (const child of await opendir(path)) {
          check();
          if (names.length + entries.length >= 10000) throw new Error('独立验收输入文件数量超过有界读取容量');
          names.push(child.name);
        }
        for (const child of names.sort()) await visit(join(path, child), name ? `${name}/${child}` : child);
      } else {
        bytes += before.size;
        if (bytes > 256 * 1024 * 1024) throw new Error('独立验收输入超过有界流式读取容量');
        const hash = createHash('sha256');
        const stream = createReadStream(path, { signal });
        for await (const chunk of stream) { check(); hash.update(chunk); }
        entry.sha256 = hash.digest('hex');
      }
      const after = await lstat(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('独立验收输入在读取过程中发生变化');
      }
    };
    await visit(directory, '');
    check();
    if (await realpath(directory) !== canonical) throw new Error('独立验收输入目录在读取过程中被替换');
    return entries;
  };
  const first = await scan();
  if (JSON.stringify(first) !== JSON.stringify(await scan())) throw new Error('独立验收输入集合在读取过程中发生变化');
  return { directory: canonical, entries: first };
}

export async function assertVerificationArtifacts(manifest: VerificationArtifactManifest, options: {
  workspaceRoot: string; signal: AbortSignal; assertCurrent?: () => void;
}) {
  const current = await readVerificationArtifacts(manifest.directory, options);
  if (JSON.stringify(current) !== JSON.stringify(manifest)) throw new Error('已冻结的独立验收输入被修改，不能复用计划或通过收据');
}
