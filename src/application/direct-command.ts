import type { DirectInvocation } from '../domain/command-chain-script';
import { directScriptRuntime } from '../infrastructure/command-script-host';
import { getConfiguredWorkspaceRoot } from '../infrastructure/database';
import { loadAgentCommandScript } from '../infrastructure/external-command-chains';

export function directHelp() {
  return loadAgentCommandScript(getConfiguredWorkspaceRoot(), 'direct-agent').help(directScriptRuntime());
}

export function runDirectCommand(input: DirectInvocation) {
  const script = loadAgentCommandScript(getConfiguredWorkspaceRoot(), 'direct-agent');
  const output = script.executeDirect!(directScriptRuntime(), input);
  if (typeof output !== 'string') throw new Error('命令脚本 executeDirect 必须同步返回协议文本');
  return output;
}
