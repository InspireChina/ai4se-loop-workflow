import { commandChainCatalogItem } from '../domain/command-chain-catalog';
import type { CommandInvocation } from '../domain/command-chain-script';
import type { CommandDatabase, CommandChainDraftRow, CommandChainExecutionRow } from '../domain/command-chain-state';
import { commandScriptRuntime } from '../infrastructure/command-script-host';
import { getConfiguredWorkspaceRoot } from '../infrastructure/database';
import { loadAgentCommandScript } from '../infrastructure/external-command-chains';

export type { CommandChainDraftRow, CommandChainExecutionRow, RequirementContextProjection } from '../domain/command-chain-state';

function scriptForDraft(draft: CommandChainDraftRow) {
  const item = commandChainCatalogItem(draft.command_chain_id || '');
  if (!item) throw new Error(`未知命令链：${draft.command_chain_id}`);
  return loadAgentCommandScript(getConfiguredWorkspaceRoot(), item.agentId);
}

export function initializeCommandChainDraft(db: CommandDatabase, execution: CommandChainExecutionRow, draft: CommandChainDraftRow) {
  scriptForDraft(draft).initialize!(commandScriptRuntime(), db, execution, draft);
}

export function cloneCommandChainDraft(db: CommandDatabase, source: CommandChainDraftRow, target: CommandChainDraftRow) {
  scriptForDraft(target).restore!(commandScriptRuntime(), db, source, target);
}

export function runCommandChainCommand(input: CommandInvocation) {
  const output = scriptForDraft(input.draft).execute!(commandScriptRuntime(), input);
  if (typeof output !== 'string') throw new Error('命令脚本 execute 必须同步返回协议文本');
  return output;
}

export function latestRequirementContextProjection(db: CommandDatabase, taskId: string) {
  const script = loadAgentCommandScript(getConfiguredWorkspaceRoot(), 'backlog-agent');
  if (!script.project) throw new Error('backlog-agent 命令脚本缺少 project 接口');
  return script.project(commandScriptRuntime(), db, taskId);
}

export function commandChainHelp(agentId = 'backlog-agent') {
  return loadAgentCommandScript(getConfiguredWorkspaceRoot(), agentId).help(commandScriptRuntime());
}
