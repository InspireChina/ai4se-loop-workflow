import { chmodSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type AgentWorkspaceTempDirectory = {
  root: string;
  directory: string;
};

export function agentWorkspaceTempDirectoryFor(
  workspaceRoot: string,
  runId: string,
): AgentWorkspaceTempDirectory {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`run id 不能用于临时目录：${runId}`);
  }
  const root = resolve(workspaceRoot, '.tmp');
  const directory = resolve(join(root, `loop-${runId}`));
  if (dirname(directory) !== root) throw new Error('Loop 临时目录越过工作区 .tmp 边界');
  return { root, directory };
}

export function createAgentWorkspaceTempDirectory(
  workspaceRoot: string,
  runId: string,
): AgentWorkspaceTempDirectory {
  const temporary = agentWorkspaceTempDirectoryFor(workspaceRoot, runId);
  mkdirSync(temporary.directory, { recursive: true, mode: 0o700 });
  try { chmodSync(temporary.directory, 0o700); } catch { /* Windows ACLs are managed by the user profile. */ }
  return temporary;
}

export function createAgentExecutionTempDirectory(
  loopTemporary: AgentWorkspaceTempDirectory,
  executionId: string,
) {
  if (!/^[A-Za-z0-9._-]+$/.test(executionId)) {
    throw new Error(`execution id 不能用于临时目录：${executionId}`);
  }
  const directory = resolve(join(loopTemporary.directory, `agent-${executionId}`));
  if (dirname(directory) !== loopTemporary.directory) {
    throw new Error('Agent 临时目录越过当前 Loop .tmp 边界');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the user profile. */ }
  return directory;
}

export function removeAgentWorkspaceTempDirectory(
  temporary: AgentWorkspaceTempDirectory | null,
): { ok: true } | { ok: false; error: string } {
  if (!temporary) return { ok: true };
  try {
    rmSync(temporary.directory, { recursive: true, force: true });
    try { rmdirSync(temporary.root); } catch { /* Keep a non-empty shared .tmp root. */ }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
