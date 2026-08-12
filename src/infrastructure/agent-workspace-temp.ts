import { chmodSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type AgentExecutionTempDirectory = {
  root: string;
  directory: string;
  executionId: string;
};

export function agentExecutionTempDirectoryFor(
  workspaceRoot: string,
  executionId: string,
): AgentExecutionTempDirectory {
  if (!/^[A-Za-z0-9._-]+$/.test(executionId)) {
    throw new Error(`execution id 不能用于临时目录：${executionId}`);
  }
  const root = resolve(workspaceRoot, '.tmp');
  const directory = resolve(join(root, `agent-${executionId}`));
  if (dirname(directory) !== root) throw new Error('Agent 临时目录越过工作区 .tmp 边界');
  return { root, directory, executionId };
}

export function createAgentExecutionTempDirectory(
  workspaceRoot: string,
  executionId: string,
) {
  const temporary = agentExecutionTempDirectoryFor(workspaceRoot, executionId);
  mkdirSync(temporary.directory, { recursive: true, mode: 0o700 });
  try { chmodSync(temporary.directory, 0o700); } catch { /* Windows ACLs are managed by the user profile. */ }
  return temporary;
}

export function removeAgentExecutionTempDirectory(
  temporary: AgentExecutionTempDirectory,
): { ok: true } | { ok: false; error: string } {
  try {
    rmSync(temporary.directory, { recursive: true, force: true });
    try { rmdirSync(temporary.root); } catch { /* Keep a non-empty shared .tmp root. */ }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
