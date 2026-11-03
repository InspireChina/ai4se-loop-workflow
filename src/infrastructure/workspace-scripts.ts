import { createHash, randomUUID } from 'node:crypto';
import { createRequire, Module } from 'node:module';
import { readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Script } from 'node:vm';

export type WorkspaceScriptSource = { relativePath: string; path: string; content: string; hash: string };
type ScriptCache = { hash: string; require: NodeJS.Require; files: WorkspaceScriptSource[] };
const caches = new Map<string, ScriptCache>();
const digest = (content: string) => createHash('sha256').update(content).digest('hex');

function scriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', '.git', '.tmp'].includes(entry.name)) return scriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.cjs') ? [path] : [];
  });
}

function currentScripts(workspace: string) {
  const root = join(workspace, '.omp', 'commands');
  let files: WorkspaceScriptSource[];
  try {
    files = scriptFiles(root).map((path) => {
      const content = readFileSync(path, 'utf8');
      return { relativePath: relative(root, path).split(sep).join('/'), path, content, hash: digest(content) };
    });
  } catch (error) {
    throw new Error(`无法读取当前工作目录 .omp/commands：${error instanceof Error ? error.message : String(error)}`);
  }
  const hash = digest(files.map((file) => `${file.relativePath}:${file.hash}`).join('\n'));
  const previous = caches.get(root);
  if (previous?.hash === hash) return previous;
  const require = previous?.require || createRequire(join(root, '__loopwork__.cjs'));
  // Invalidate local modules together, so edits to shared validators and helpers
  // are picked up along with the Agent entry, including atomic file replacement.
  for (const path of Object.keys(require.cache)) {
    const local = relative(root, path);
    if (local && !local.startsWith(`..${sep}`) && !isAbsolute(local)) delete require.cache[path];
  }
  const cache = { hash, require, files };
  caches.set(root, cache);
  return cache;
}

export function workspaceScriptSources(workspace: string) { return currentScripts(workspace).files; }

export function loadWorkspaceScript<T>(workspace: string, relativePath: string): T {
  const cache = currentScripts(workspace);
  const source = cache.files.find((file) => file.relativePath === relativePath);
  if (!source) throw new Error(`命令脚本不存在：${join(workspace, '.omp', 'commands', relativePath)}。请在工作目录准备原始脚本。`);
  try { return cache.require(source.path) as T; }
  catch (error) { throw new Error(`${source.path}：${error instanceof Error ? error.message : String(error)}`); }
}

// Syntax checking does not evaluate editor or Chat output.
export function validateWorkspaceScript(content: unknown, name = 'agent.cjs') {
  if (typeof content !== 'string' || !content.trim()) throw new Error('脚本源码不能为空');
  if (content.length > 1_000_000) throw new Error('脚本不能超过 1000000 字符');
  new Script(Module.wrap(content), { filename: name });
  return content;
}

export function saveWorkspaceScript(workspace: string, relativePath: unknown, content: unknown, expectedHash: unknown) {
  const source = workspaceScriptSources(workspace).find((file) => file.relativePath === relativePath);
  if (!source) throw new Error('只能编辑当前工作目录中已发现的 .cjs 脚本');
  const root = realpathSync(join(workspace, '.omp', 'commands'));
  const actual = realpathSync(source.path);
  const local = relative(root, actual);
  if (!local || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('脚本路径越过工作目录 .omp/commands');
  const code = validateWorkspaceScript(content, source.path);
  const temporary = join(dirname(source.path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, code, { mode: 0o600 });
    if (digest(readFileSync(source.path, 'utf8')) !== expectedHash) throw new Error('脚本已被其他编辑修改，请重新检测后再保存');
    renameSync(temporary, source.path);
  } finally { rmSync(temporary, { force: true }); }
}
