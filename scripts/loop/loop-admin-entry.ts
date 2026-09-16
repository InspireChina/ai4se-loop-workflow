import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { runAdminCommand } from '../../src/application/admin-command';
import { AdminManagementStore } from '../../src/infrastructure/admin-management-store';

function main() {
  const { LOOP_ADMIN_DB, LOOP_ADMIN_CASE_ID, LOOP_ADMIN_ATTEMPT_ID, LOOP_ADMIN_SESSION_ID, LOOP_ADMIN_COMMAND_TOKEN } = process.env;
  if (!LOOP_ADMIN_DB || !LOOP_ADMIN_CASE_ID || !LOOP_ADMIN_ATTEMPT_ID || !LOOP_ADMIN_SESSION_ID || !LOOP_ADMIN_COMMAND_TOKEN) {
    throw new Error('管理命令只能在有效的 Admin 执行上下文内使用');
  }
  const raw = process.argv.slice(2);
  const args: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const argument = raw[index];
    if (!['--payload-file', '--result-file'].includes(argument)) { args.push(argument); continue; }
    const path = raw[++index];
    if (!path || !process.env.LOOP_AGENT_TMP_DIR) throw new Error(`${argument} 必须读取当前 Admin 临时目录中的文件`);
    const directory = realpathSync(resolve(process.env.LOOP_AGENT_TMP_DIR));
    const file = realpathSync(resolve(path));
    const relation = relative(directory, file);
    if (!relation || relation.startsWith('..') || isAbsolute(relation)) throw new Error(`${argument} 不允许读取临时目录外的文件`);
    const content = readFileSync(file, 'utf8');
    if (content.length > 100_000) throw new Error(`${argument} 文件超过 100000 字符`);
    args.push(argument.slice(0, -5), content);
  }
  const store = new AdminManagementStore(LOOP_ADMIN_DB);
  try {
    const output = runAdminCommand(store, {
      caseId: LOOP_ADMIN_CASE_ID, attemptId: LOOP_ADMIN_ATTEMPT_ID, sessionId: LOOP_ADMIN_SESSION_ID, token: LOOP_ADMIN_COMMAND_TOKEN,
    }, args);
    process.stdout.write(`${output}\n`);
  } finally { store.close(); }
}

try { main(); } catch (error) {
  process.stderr.write(`loop-admin: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
