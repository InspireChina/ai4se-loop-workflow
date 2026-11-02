import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const prefix = '@loopwork-document-file:';
function dataRoot() { return resolve(process.env.LOOP_DATA_ROOT || join(process.env.LOOP_APP_ROOT || process.cwd(), 'data', 'dji')); }
export function documentFilesRoot() {
  if (process.env.LOOP_FILES_ROOT) return resolve(process.env.LOOP_FILES_ROOT);
  const config = join(dataRoot(), 'file-storage.json');
  if (!existsSync(config)) return join(dataRoot(), 'files');
  const settings = JSON.parse(readFileSync(config, 'utf8')) as { root: string };
  return resolve(settings.root);
}
export function setDocumentFilesRoot(input: string) {
  if (!input.trim()) throw new Error('请输入文件存放目录');
  const requested = resolve(input.trim());
  mkdirSync(requested, { recursive: true });
  if (!statSync(requested).isDirectory()) throw new Error('文件存放位置必须是文件夹');
  const root = realpathSync(requested);
  mkdirSync(dataRoot(), { recursive: true });
  const config = join(dataRoot(), 'file-storage.json');
  const temporary = `${config}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ root }, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, config);
  return root;
}
export function storeDocumentBody(taskId: string, documentId: string, content: string, format = 'markdown') {
  const ext = format === 'json' ? 'json' : format === 'text' ? 'txt' : 'md';
  const digest = createHash('sha256').update(content).digest('hex');
  const path = join(documentFilesRoot(), encodeURIComponent(taskId), 'documents', encodeURIComponent(documentId), `${digest}.${ext}`);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }
  return `${prefix}${path}`;
}
export function readDocumentBody(value: string) {
  return value.startsWith(prefix) ? readFileSync(value.slice(prefix.length), 'utf8') : value;
}
export function documentBodyPath(value: string) { return value.startsWith(prefix) ? value.slice(prefix.length) : null; }
export function hydrateDocument<T extends { content: string }>(document: T): T { return { ...document, content: readDocumentBody(document.content) }; }
