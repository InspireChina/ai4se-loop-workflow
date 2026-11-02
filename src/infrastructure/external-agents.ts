import type { AgentExecutionOptions } from './agent-executor';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';

export type ExternalAgent = { path: string; directory: string; prompt: string; hash: string; revision: number; updatedAt: string; metadata: Record<string, unknown> };
export type DetectedAgent = { id: string; path: string; error: string | null };
const validId = (id: string) => /^[a-z][a-z0-9-]*$/.test(id);
function readAgent(path: string): ExternalAgent {
  let text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  let metadata: Record<string, unknown> = {};
  if (/^---\r?\n/.test(text)) {
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) throw new Error(`Agent YAML frontmatter 未闭合：${path}`);
    const parsed = parse(frontmatter[1]);
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error(`Agent frontmatter 必须是对象：${path}`);
    metadata = parsed || {};
    text = text.slice(frontmatter[0].length);
  }
  const prompt = text.trim();
  if (!prompt) throw new Error(`Agent Prompt 不能为空：${path}`);
  const info = statSync(path);
  const agent = { path, directory: realpathSync(dirname(path)), prompt,
    hash: createHash('sha256').update(prompt).digest('hex'), revision: Math.floor(info.mtimeMs), updatedAt: info.mtime.toISOString(), metadata };
  externalAgentOptions(agent);
  return agent;
}
// Read the selected project's working directory only. No bundled/global fallback or seed copies.
export function discoverExternalAgents(workspace: string): DetectedAgent[] {
  const detected: DetectedAgent[] = [];
  function visit(directory: string, depth: number) {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      let id = basename(entry.name, entry.name.slice(-3));
      let error: string | null = null;
      try {
        const agent = readAgent(path);
        if (agent.metadata.name !== undefined) {
          if (typeof agent.metadata.name !== 'string' || !validId(agent.metadata.name)) throw new Error(`Agent name 必须是有效的角色 ID：${path}`);
          id = agent.metadata.name;
        }
        if (!validId(id)) throw new Error(`Agent ID 无效：${path}`);
      } catch (e) { error = e instanceof Error ? e.message : String(e); }
      detected.push({ id, path, error });
    }
  }
  visit(join(workspace, '.omp', 'agents'), 0);
  for (const agent of detected) {
    if (detected.filter((other) => other.id === agent.id).length > 1) agent.error = `Agent ID 重复：${agent.id}。请在 .omp/agents 中只保留一个对应定义。`;
  }
  return detected;
}
export function externalAgentPath(workspace: string, agentId: string) {
  if (!validId(agentId)) throw new Error('Agent ID 无效');
  return discoverExternalAgents(workspace).find((agent) => agent.id === agentId)?.path || join(workspace, '.omp', 'agents', `${agentId}.md`);
}
export function loadExternalAgent(workspace: string, agentId: string): ExternalAgent {
  if (!validId(agentId)) throw new Error('Agent ID 无效');
  const detected = discoverExternalAgents(workspace).find((agent) => agent.id === agentId);
  if (!detected) throw new Error(`Agent 定义不存在：${join(workspace,'.omp','agents',`${agentId}.md`)}。请在当前工作目录的 .omp/agents 中准备该角色的定义。`);
  if (detected.error) throw new Error(detected.error);
  return readAgent(detected.path);
}

export function externalAgentOptions(agent: ExternalAgent) {
  const list = (value: unknown, field: string): string[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value.split(',').map(v=>v.trim()).filter(Boolean);
    if (Array.isArray(value) && value.every(v=>typeof v==='string')) return value.map(v=>v.trim()).filter(Boolean);
    throw new Error(`${agent.path}: ${field} 必须是字符串或字符串列表`);
  };
  const models=list(agent.metadata.model,'model');
  const tools=list(agent.metadata.tools,'tools');
  const skills=list(agent.metadata.skills,'skills');
  if (models && models.length > 1) throw new Error(`${agent.path}: 主流程 Agent 只支持一个 model；子 Agent 的多模型策略由 OMP 自行管理`);
  const thinking=agent.metadata['thinking-level'] ?? agent.metadata.thinking ?? agent.metadata.thinkingLevel;
  const levels=['off','minimal','low','medium','high','xhigh','max','auto'];
  if(thinking!==undefined && (typeof thinking!=='string'||!levels.includes(thinking)))throw new Error(`${agent.path}: 无效的思考强度`);
  return { model:models?.[0], tools, skills, reasoningEffort:thinking as import('./agent-executor').AgentExecutionOptions['reasoningEffort'], systemPromptFile:agent.path, systemPromptText:agent.prompt };
}

// Runtime edits override only explicitly selected values. Empty/default fields
// inherit from the external definition, then the flow defaults and OMP itself.
export function mergeExternalAgentOptions(
  agent: ExternalAgent,
  defaults: AgentExecutionOptions = {},
  overrides: AgentExecutionOptions = {},
): AgentExecutionOptions {
  const defined = (options: AgentExecutionOptions) => Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );
  return {
    ...defined(defaults),
    ...defined(externalAgentOptions(agent)),
    ...defined(overrides),
    systemPromptFile: agent.path,
    systemPromptText: agent.prompt,
  };
}
