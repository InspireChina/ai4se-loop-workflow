import { statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { agentCommandChainCatalog, commandChainCatalogItem } from '../domain/command-chain-catalog';
import { isFlowAgentId } from '../domain/agent-profile';
import { parseRequirementMetadata, requirementMetadataDefinition } from '../domain/requirement-metadata';
import type { CommandChainDefinition } from '../domain/command-chain-definition';
import type { AgentCommandScript } from '../domain/command-chain-script';
import { loadWorkspaceScript, workspaceScriptSources, type WorkspaceScriptSource } from './workspace-scripts';

export type ExternalCommandChainDocument = { commandChainId: string; label: string; definition: CommandChainDefinition };
export type ExternalCommandChainFile = {
  agentId: string; path: string; hash: string; updatedAt: string;
  files: WorkspaceScriptSource[]; documents: ExternalCommandChainDocument[];
};
type DefinitionTools = { compile(id: string, input: unknown): CommandChainDefinition; authoringGuide(id: string): string };

export function definitionTools(workspace: string): DefinitionTools {
  const factory = loadWorkspaceScript<(host: unknown) => DefinitionTools>(workspace, 'workflow/definitions.cjs');
  if (typeof factory !== 'function') throw new Error('workflow/definitions.cjs 必须导出 definition tools 工厂');
  return factory({ commandChainCatalogItem, parseRequirementMetadata, requirementMetadataDefinition });
}

export function externalCommandChainPath(workspace: string, agentId: string) {
  if (!isFlowAgentId(agentId)) throw new Error(`未知 Agent：${agentId}`);
  return join(workspace, '.omp', 'commands', `${agentId}.cjs`);
}

export function loadAgentCommandScript(workspace: string, agentId: string): AgentCommandScript {
  externalCommandChainPath(workspace, agentId);
  const script = loadWorkspaceScript<AgentCommandScript>(workspace, `${agentId}.cjs`);
  if (!script || script.apiVersion !== 1) throw new Error(`${agentId} 命令脚本 apiVersion 必须是 1`);
  if (script.agent !== agentId) throw new Error(`命令脚本必须绑定 Agent ${agentId}`);
  const methods = agentId === 'direct-agent'
    ? ['describe', 'executeDirect', 'help']
    : ['describe', 'initialize', 'execute', 'validate', 'result', 'restore', 'help'];
  if (agentId === 'backlog-agent') methods.push('project');
  for (const name of methods) {
    if (typeof script[name as keyof AgentCommandScript] !== 'function') throw new Error(`${agentId} 命令脚本缺少接口：${name}`);
    const method = script[name as keyof AgentCommandScript] as Function;
    if (['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'].includes(method.constructor.name)) throw new Error(`${agentId}.${name} 必须使用同步接口`);
  }
  return script;
}

const strings = z.array(z.string());
const field = z.object({ type: z.enum(['string', 'enum', 'array']), required: z.boolean(),
  label: z.string().optional(), values: strings.optional(), minItems: z.number().int().positive().optional(),
  itemType: z.enum(['string','number','object']).optional() });
const block = z.object({ title: z.string(), cardinality: z.enum(['one', 'many']), format: z.enum(['markdown', 'yaml', 'text']),
  writable: z.boolean(), required: z.boolean(), render: z.boolean(), fields: z.record(field) });
const phase = z.object({
  type: z.enum(['builtin', 'artifact', 'confirmation', 'metadata']), builtin: z.string().nullable(),
  artifactBlocks: z.array(z.object({ artifactId: z.string(), blockId: z.string() })), inputs: strings,
  title: z.string(), instructions: z.string(), objective: z.string(), required: z.string(), prohibited: z.string(),
  contexts: strings, workCommands: strings, completeCommand: z.literal('phase complete'),
  rewindCommand: z.string().nullable(), commands: strings, reviewBeforeSubmit: strings, validators: strings, transitions: strings,
});
const definitionContract = z.object({
  version: z.number().int().positive(), id: z.string(), agent: z.string(),
  artifacts: z.record(z.object({ type: z.enum(['builtin', 'repository']), adapter: z.string().nullable(), title: z.string(), blocks: z.record(block) })),
  inputs: z.record(z.object({ metadataKey: z.string(), required: z.boolean(), defaultValue: z.string().optional() })),
  decisionTrees: z.record(z.object({ builtin: z.string(), minOptions: z.number().int().positive(),
    recommendationAuthorities: strings, resolutionAuthorities: strings })),
  phases: z.record(phase).refine(value => Object.keys(value).length > 0, '阶段不能为空'),
});

export function loadExternalCommandChains(workspace: string, agentId: string): ExternalCommandChainFile {
  const path = externalCommandChainPath(workspace, agentId);
  const script = loadAgentCommandScript(workspace, agentId);
  const runtimePath = agentId === 'direct-agent' ? 'workflow/direct-runtime.cjs' : 'workflow/command-chain-runtime.cjs';
  if (typeof loadWorkspaceScript(workspace, runtimePath) !== 'function') throw new Error(`${runtimePath} 必须导出运行库工厂函数`);
  const tools = definitionTools(workspace);
  const definitions = script.describe({ define: tools.compile });
  if (!Array.isArray(definitions)) throw new Error(`${path}: describe 必须同步返回命令链数组`);
  const catalog = agentCommandChainCatalog(agentId);
  const documents = new Map<string, ExternalCommandChainDocument>();
  for (const value of definitions) {
    const definition = definitionContract.parse(value) as CommandChainDefinition;
    const item = catalog.find(item => item.id === definition.id);
    if (!item || definition.agent !== agentId) throw new Error(`命令链 ${definition.id} 不属于 Agent ${agentId}`);
    if (documents.has(item.id)) throw new Error(`命令链 ID 重复：${item.id}`);
    const phases = Object.keys(definition.phases);
    for (const [id, phase] of Object.entries(definition.phases)) {
      if (phase.transitions.some(target => !phases.includes(target))) throw new Error(`阶段 ${id} 引用了未知跳转目标`);
    }
    documents.set(item.id, { commandChainId: item.id, label: item.label, definition });
  }
  for (const item of catalog) if (!documents.has(item.id)) throw new Error(`${path}: 缺少命令链 ${item.id}`);
  const shared = ['workflow/definitions.cjs', runtimePath];
  const files = workspaceScriptSources(workspace).filter(file => file.relativePath === `${agentId}.cjs` || shared.includes(file.relativePath));
  return { agentId, path, hash: files.map(file => file.hash).join(':'), updatedAt: statSync(path).mtime.toISOString(),
    files, documents: catalog.map(item => documents.get(item.id)!) };
}
