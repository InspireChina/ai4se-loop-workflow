import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { agentResultSchema, deliverySpecSchema } from '../domain/agent-result';
import { AgentCommandValidationError } from '../domain/agent-command-rejection';
import { loopAgentCommandPrefix } from '../domain/agent-command-profile';
import { loadCommandChainDefinition } from '../domain/command-chain-definition';
import { deliveryUnitContractSchema } from '../domain/delivery-unit';
import { analysisDecisionMode, parseRequirementMetadata, requirementMetadataDefinition, requirementMetadataValueLabel } from '../domain/requirement-metadata';
import type { CommandRuntime, DirectRuntime, ScriptValidationContext, ScriptResultContext } from '../domain/command-chain-script';
import { commandChainCatalogItem } from '../domain/command-chain-catalog';
import { loadAgentCommandScript } from './external-command-chains';
import { getConfiguredWorkspaceRoot } from './database';
import { loadWorkspaceScript } from './workspace-scripts';

// Stable capabilities injected into the original workspace implementation.
// Tokens, execution authorization and dispatch remain outside this host.
export function commandScriptRuntime(): CommandRuntime {
  const factory = loadWorkspaceScript<(host: unknown) => CommandRuntime>(getConfiguredWorkspaceRoot(), 'workflow/command-chain-runtime.cjs');
  return factory({ createHash, randomUUID, parse, stringify, agentResultSchema, deliverySpecSchema,
    AgentCommandValidationError, loopAgentCommandPrefix, loadCommandChainDefinition, deliveryUnitContractSchema,
    analysisDecisionMode, parseRequirementMetadata, requirementMetadataDefinition, requirementMetadataValueLabel,
    validateScript(context: ScriptValidationContext) {
      const item = commandChainCatalogItem(context.draft.command_chain_id || '');
      if (!item) throw new Error('未知命令链');
      const result = loadAgentCommandScript(getConfiguredWorkspaceRoot(), item.agentId).validate!(context);
      if (!Array.isArray(result) || result.some(value => typeof value !== 'string')) throw new Error('validate 必须同步返回错误消息数组');
      return result;
    },
    buildScriptResult(context: ScriptResultContext) {
      const item = commandChainCatalogItem(context.draft.command_chain_id || '');
      if (!item) throw new Error('未知命令链');
      return loadAgentCommandScript(getConfiguredWorkspaceRoot(), item.agentId).result!(context);
    },
  });
}

export function directScriptRuntime(): DirectRuntime {
  const factory = loadWorkspaceScript<(host: unknown) => DirectRuntime>(getConfiguredWorkspaceRoot(), 'workflow/direct-runtime.cjs');
  return factory({ agentResultSchema });
}
