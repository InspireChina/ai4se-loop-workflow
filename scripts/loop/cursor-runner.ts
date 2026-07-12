#!/usr/bin/env tsx
import '../load-env.js';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendLoopRunLog, endRun } from '../../src/application/tasks';
import { paths } from '../../src/infrastructure/database';

const leaseId = process.argv[2];
if (!leaseId) throw new Error('missing lease id');

function compact(value: string, limit = 1600) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function stringifyValue(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function logCursorJsonLine(line: string) {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = String(event.type || event.event || event.kind || 'event');
    const tool = stringifyValue(event.tool || event.toolName || event.name);
    const text = stringifyValue(event.text || event.message || event.delta || event.content || event.summary);
    if (type.toLowerCase().includes('tool') || tool) {
      return `[Cursor工具] type=${type}${tool ? ` tool=${compact(tool, 200)}` : ''} - ${compact(text || line)}`;
    }
    if (text) return `[Cursor输出] type=${type} - ${compact(text)}`;
    return `[Cursor事件] ${compact(line)}`;
  } catch {
    return `[Cursor输出] ${compact(line)}`;
  }
}

function buildPrompt(loopCommand: string) {
  return [
    '你是 Loop Engineering 的 Cursor Agent 执行器。',
    '',
    '请执行本轮 loop。注意：本轮 run lease 已经由 App 创建，不要再调用 run-begin。',
    '',
    `Run Token: ${leaseId}`,
    `Loop App Root: ${paths.appRoot}`,
    `Workspace Root: ${paths.root}`,
    '',
    '所有状态读取和写入必须通过：',
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} ...`,
    '',
    '关键动作必须写入运行日志：',
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} run-log --run-token ${leaseId} --agent AGENT --task-id TASK --pipeline PIPELINE --event start --message "开始处理"`,
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} run-log --run-token ${leaseId} --agent AGENT --task-id TASK --pipeline PIPELINE --event tool-call --tool TOOL --message "准备调用工具"`,
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} run-log --run-token ${leaseId} --agent AGENT --task-id TASK --pipeline PIPELINE --event tool-result --tool TOOL --message "工具结果摘要"`,
    `python ${join(paths.appRoot, 'scripts/loop/loopctl.py')} run-log --run-token ${leaseId} --agent AGENT --task-id TASK --pipeline PIPELINE --event complete --message "处理完成"`,
    '',
    '下面是 /loop 原始协议，请遵守，但把 run-begin/run-end 替换为使用上面的既有 Run Token：',
    '',
    loopCommand,
  ].join('\n');
}

async function main() {
  const loopCommand = await readFile(join(paths.appRoot, '.cursor/commands/loop.md'), 'utf8');
  const prompt = buildPrompt(loopCommand);
  const cursorBin = process.env.CURSOR_CLI || 'cursor';
  const args = ['agent', '--print', '--output-format', 'stream-json', '--trust', '--force', '--workspace', paths.root, prompt];
  const maxRuntimeMs = Number(process.env.CURSOR_AGENT_TIMEOUT_MS || 30 * 60 * 1000);
  const idleTimeoutMs = Number(process.env.CURSOR_AGENT_IDLE_TIMEOUT_MS || 10 * 60 * 1000);
  let lastOutputAt = Date.now();
  let timedOut = false;

  await appendLoopRunLog(leaseId, `[Cursor] 启动 Cursor Agent：${cursorBin} agent --print --output-format stream-json --force --workspace ${paths.root}`);

  const child = spawn(cursorBin, args, {
    cwd: paths.root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    lastOutputAt = Date.now();
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines.filter(Boolean)) void appendLoopRunLog(leaseId, logCursorJsonLine(line));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    lastOutputAt = Date.now();
    stderrBuffer += chunk.toString('utf8');
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || '';
    for (const line of lines.filter(Boolean)) void appendLoopRunLog(leaseId, `[Cursor错误] ${compact(line)}`);
  });

  const terminate = async (reason: string) => {
    if (timedOut) return;
    timedOut = true;
    await appendLoopRunLog(leaseId, `[Cursor] ${reason}，正在终止 Cursor Agent`);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5000).unref();
  };

  const maxTimer = setTimeout(() => void terminate(`超过最大运行时间 ${Math.round(maxRuntimeMs / 1000)} 秒`), maxRuntimeMs);
  const idleTimer = setInterval(() => {
    if (Date.now() - lastOutputAt > idleTimeoutMs) void terminate(`超过空闲时间 ${Math.round(idleTimeoutMs / 1000)} 秒`);
  }, Math.min(30000, idleTimeoutMs));

  const exitCode = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  clearTimeout(maxTimer);
  clearInterval(idleTimer);
  if (stdoutBuffer.trim()) await appendLoopRunLog(leaseId, logCursorJsonLine(stdoutBuffer));
  if (stderrBuffer.trim()) await appendLoopRunLog(leaseId, `[Cursor错误] ${compact(stderrBuffer)}`);
  await appendLoopRunLog(leaseId, `[Cursor] Cursor Agent 已退出 code=${exitCode ?? 'signal'}`);
  await endRun(leaseId, false, { stopRunner: false });
}

main().catch(async (error) => {
  await appendLoopRunLog(leaseId, `[Cursor错误] ${error instanceof Error ? error.message : String(error)}`);
  await endRun(leaseId, true, { stopRunner: false });
});
