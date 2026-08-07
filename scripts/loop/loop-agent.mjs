#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

function fail(message) {
  process.stderr.write(`loop-agent: ${message}\n`);
  process.exit(1);
}

const executionId = process.env.LOOP_EXECUTION_ID;
const token = process.env.LOOP_EXECUTION_TOKEN;
const internalWorkType = process.env.LOOP_INTERNAL_WORK_TYPE;
const internalWorkId = process.env.LOOP_INTERNAL_WORK_ID;
const internalSessionId = process.env.LOOP_INTERNAL_SESSION_ID;
const internalToken = process.env.LOOP_INTERNAL_COMMAND_TOKEN;
const hasFlowContext = Boolean(executionId && token);
const hasInternalContext = Boolean(
  internalWorkType && internalWorkId && internalSessionId && internalToken,
);
if (!hasFlowContext && !hasInternalContext) {
  fail('命令只能在活动 Agent execution 内使用');
}

const rawArgs = process.argv.slice(2);

function assertAgentTemporaryFile(path, argument) {
  const temporaryDirectory = process.env.LOOP_AGENT_TMP_DIR;
  if (!temporaryDirectory) return;
  const resolvedDirectory = resolve(temporaryDirectory);
  const resolvedPath = resolve(path);
  const relation = relative(resolvedDirectory, resolvedPath);
  if (!relation || relation.startsWith('..') || resolve(resolvedDirectory, relation) !== resolvedPath) {
    throw new Error(`${argument} 必须读取 $LOOP_AGENT_TMP_DIR 内的文件：${resolvedDirectory}`);
  }
}

try {
  const args = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (!argument.startsWith('--') || !argument.endsWith('-file')) {
      args.push(argument);
      continue;
    }
    const path = rawArgs[index + 1];
    if (!path || path.startsWith('--')) {
      throw new Error(`${argument} 缺少文件路径`);
    }
    assertAgentTemporaryFile(path, argument);
    const content = await readFile(path, 'utf8');
    if (content.length > 100_000) {
      throw new Error(`${argument} 文件超过 100000 字符`);
    }
    args.push(argument.slice(0, -5), content);
    index += 1;
  }
  let output;
  if (hasInternalContext) {
    const { runInternalAgentCommand } = await tsImport(
      '../../src/application/internal-agent-command-drafts.ts',
      import.meta.url,
    );
    output = await runInternalAgentCommand({
      workType: internalWorkType,
      workId: internalWorkId,
      sessionId: internalSessionId,
      token: internalToken,
      args,
    });
  } else {
    const { runAgentCommand } = await tsImport(
      '../../src/application/agent-command-drafts.ts',
      import.meta.url,
    );
    output = await runAgentCommand({
      executionId,
      token,
      args,
    });
  }
  process.stdout.write(`${output}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (['requirement-context', 'delivery-plan', 'delivery-analysis', 'implementation', 'verification', 'review'].includes(rawArgs[0])) {
    const namespace = rawArgs[0];
    const firstFlag = rawArgs.findIndex((argument) => argument.startsWith('--'));
    const command = rawArgs.slice(0, firstFlag < 0 ? rawArgs.length : firstFlag).join(' ');
    process.stderr.write([
      '# COMMAND RESULT',
      '',
      `- Command: \`${command}\``,
      '- Outcome: rejected',
      '',
      '# NEXT',
      '',
      '- Action: correct_and_retry',
      `- Refresh If Needed: \`${namespace} status\``,
      '',
      '# GUIDANCE',
      '',
      message,
      '',
    ].join('\n'));
    process.exit(1);
  }
  fail(message);
}
