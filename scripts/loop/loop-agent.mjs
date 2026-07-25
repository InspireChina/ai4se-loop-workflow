#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';
import { readFile } from 'node:fs/promises';

function fail(message) {
  process.stderr.write(`loop-agent: ${message}\n`);
  process.exit(1);
}

const executionId = process.env.LOOP_EXECUTION_ID;
const token = process.env.LOOP_EXECUTION_TOKEN;
if (!executionId || !token) {
  fail('命令只能在活动 Agent execution 内使用');
}

try {
  const rawArgs = process.argv.slice(2);
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
    const content = await readFile(path, 'utf8');
    if (content.length > 100_000) {
      throw new Error(`${argument} 文件超过 100000 字符`);
    }
    args.push(argument.slice(0, -5), content);
    index += 1;
  }
  const { runAgentCommand } = await tsImport(
    '../../src/application/agent-command-drafts.ts',
    import.meta.url,
  );
  const output = await runAgentCommand({
    executionId,
    token,
    args,
  });
  process.stdout.write(`${output}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
