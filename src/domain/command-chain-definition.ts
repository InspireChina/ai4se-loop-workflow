import { parse } from 'yaml';
import type { RequirementMetadataKey } from './requirement-metadata';
import { getConfiguredWorkspaceRoot } from '../infrastructure/database';
import { loadExternalCommandChains, definitionTools } from '../infrastructure/external-command-chains';
import { commandChainCatalogItem } from './command-chain-catalog';

export type CommandChainFieldDefinition = {
  type: 'string' | 'enum' | 'array';
  required: boolean;
  label?: string;
  values?: string[];
  minItems?: number;
  itemType?: 'string' | 'number' | 'object';
};

export type CommandChainBlockDefinition = {
  title: string;
  cardinality: 'one' | 'many';
  format: 'markdown' | 'yaml' | 'text';
  writable: boolean;
  required: boolean;
  render: boolean;
  fields: Record<string, CommandChainFieldDefinition>;
};

export type CommandChainArtifactStorage = 'builtin' | 'repository';

export type CommandChainArtifactDefinition = {
  type: CommandChainArtifactStorage;
  adapter: string | null;
  title: string;
  blocks: Record<string, CommandChainBlockDefinition>;
};

export type CommandChainPhaseDefinition = {
  type: 'builtin' | 'artifact' | 'confirmation' | 'metadata';
  builtin: string | null;
  artifactBlocks: { artifactId: string; blockId: string }[];
  inputs: string[];
  title: string;
  instructions: string;
  objective: string;
  required: string;
  prohibited: string;
  contexts: string[];
  workCommands: string[];
  completeCommand: 'phase complete';
  rewindCommand: string | null;
  commands: string[];
  reviewBeforeSubmit: string[];
  validators: string[];
  transitions: string[];
};

export type CommandChainInputDefinition = {
  metadataKey: RequirementMetadataKey;
  required: boolean;
  defaultValue?: string;
};

type ArtifactBlockReference = {
  artifactId: string;
  blockId: string;
  block: CommandChainBlockDefinition;
};

export type CommandChainDecisionTreeDefinition = {
  builtin: string;
  minOptions: number;
  recommendationAuthorities: string[];
  resolutionAuthorities: string[];
};

export type CommandChainDefinition = {
  version: number;
  id: string;
  agent: string;
  artifacts: Record<string, CommandChainArtifactDefinition>;
  inputs: Record<string, CommandChainInputDefinition>;
  decisionTrees: Record<string, CommandChainDecisionTreeDefinition>;
  phases: Record<string, CommandChainPhaseDefinition>;
};


export { COMMAND_CHAIN_FILE_BY_ID } from './command-chain-catalog';

// Kept for structured artifact/schema tests; runtime definitions come from JS modules.
export function parseCommandChainDefinition(id: string, text: string): CommandChainDefinition {
  return definitionTools(getConfiguredWorkspaceRoot()).compile(id, parse(text));
}

export function commandChainAuthoringGuide(id: string) {
  return definitionTools(getConfiguredWorkspaceRoot()).authoringGuide(id);
}

export function loadCommandChainDefinition(id: string): CommandChainDefinition {
  const item = commandChainCatalogItem(id);
  if (!item) throw new Error(`未知命令链：${id}`);
  const source = loadExternalCommandChains(getConfiguredWorkspaceRoot(), item.agentId);
  return source.documents.find(document => document.commandChainId === id)!.definition;
}
