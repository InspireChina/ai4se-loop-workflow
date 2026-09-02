import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { runAgentCommand } from '../../src/application/agent-command-drafts';
import { runInternalAgentCommand } from '../../src/application/internal-agent-command-drafts';
import { runVerificationAssistanceCommand } from '../../src/application/verification-assistance';
import { rejectionFromError, renderAgentCommandRejection } from '../../src/domain/agent-command-rejection';

function fail(message: string): never {
  process.stderr.write(`loop-agent: ${message}\n`);
  process.exit(1);
}

const executionId = process.env.LOOP_EXECUTION_ID;
const token = process.env.LOOP_EXECUTION_TOKEN;
const internalWorkType = process.env.LOOP_INTERNAL_WORK_TYPE;
const internalWorkId = process.env.LOOP_INTERNAL_WORK_ID;
const internalSessionId = process.env.LOOP_INTERNAL_SESSION_ID;
const internalToken = process.env.LOOP_INTERNAL_COMMAND_TOKEN;
const assistanceJobId = process.env.LOOP_VERIFICATION_ASSISTANCE_JOB_ID;
const assistanceSessionId = process.env.LOOP_VERIFICATION_ASSISTANCE_SESSION_ID;
const assistanceToken = process.env.LOOP_VERIFICATION_ASSISTANCE_COMMAND_TOKEN;
const hasFlowContext = Boolean(executionId && token);
const hasInternalContext = Boolean(internalWorkType && internalWorkId && internalSessionId && internalToken);
const hasAssistanceContext = Boolean(assistanceJobId && assistanceSessionId && assistanceToken);
if (!hasFlowContext && !hasInternalContext && !hasAssistanceContext) fail('命令只能在活动 Agent execution 内使用');

const rawArgs = process.argv.slice(2);

function assertAgentTemporaryFile(path: string, argument: string) {
  const temporaryDirectory = process.env.LOOP_AGENT_TMP_DIR;
  if (!temporaryDirectory) return;
  const resolvedDirectory = resolve(temporaryDirectory);
  const resolvedPath = resolve(path);
  const relation = relative(resolvedDirectory, resolvedPath);
  if (!relation || relation.startsWith('..') || resolve(resolvedDirectory, relation) !== resolvedPath) {
    throw new Error(`${argument} 必须读取 $LOOP_AGENT_TMP_DIR 内的文件：${resolvedDirectory}`);
  }
}

async function main() {
try {
  const args: string[] = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (!argument.startsWith('--') || !argument.endsWith('-file')) {
      args.push(argument);
      continue;
    }
    const path = rawArgs[index + 1];
    if (!path || path.startsWith('--')) throw new Error(`${argument} 缺少文件路径`);
    assertAgentTemporaryFile(path, argument);
    const content = await readFile(path, 'utf8');
    if (content.length > 100_000) throw new Error(`${argument} 文件超过 100000 字符`);
    args.push(argument.slice(0, -5), content);
    index += 1;
  }
  const output = hasAssistanceContext
    ? await runVerificationAssistanceCommand({
        jobId: assistanceJobId!, sessionId: assistanceSessionId!, token: assistanceToken!, args,
      })
    : hasInternalContext
    ? await runInternalAgentCommand({
        workType: internalWorkType as 'evolution', workId: internalWorkId!, sessionId: internalSessionId!, token: internalToken!, args,
      })
    : await runAgentCommand({ executionId: executionId!, token: token!, args });
  process.stdout.write(`${output}\n`);
} catch (error) {
  if (hasFlowContext || hasInternalContext || hasAssistanceContext) {
    const firstFlag = rawArgs.findIndex((argument) => argument.startsWith('--'));
    const command = rawArgs.slice(0, firstFlag < 0 ? rawArgs.length : firstFlag).join(' ');
    const rejection = rejectionFromError(error);
    if (rawArgs[0] === 'direct') rejection.refreshCommand = 'direct run';
    else if (hasInternalContext || hasAssistanceContext) rejection.refreshCommand = `${rawArgs[0] || 'verification-assistance'} status`;
    process.stderr.write(renderAgentCommandRejection(command, rejection));
    process.exit(1);
  }
  fail(error instanceof Error ? error.message : String(error));
}
}

void main();
