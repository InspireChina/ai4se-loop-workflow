import type { AgentExecutionOptions } from './agent-executor';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';
import { isFlowAgentId } from '../domain/agent-profile';

export type ExternalCommandPrompt = {
  id: string; path: string; directory: string; prompt: string; hash: string; sourceHash: string;
  revision: number; updatedAt: string; metadata: Record<string, unknown>;
};
export type DetectedCommandPrompt = { id: string; path: string; error: string | null };
const validId = (id: string) => /^[a-z][a-z0-9-]*$/.test(id);

function readCommandPrompt(path: string): ExternalCommandPrompt {
  const source = readFileSync(path, 'utf8');
  let text = source.replace(/^\uFEFF/, '');
  const id = basename(path, '.md');
  if (!validId(id)) throw new Error(`Command ID 无效：${path}`);
  let metadata: Record<string, unknown> = {};
  if (/^---\r?\n/.test(text)) {
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) throw new Error(`Command frontmatter 未闭合：${path}`);
    const parsed = parse(frontmatter[1]);
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error(`Command frontmatter 必须是对象：${path}`);
    metadata = parsed || {};
    text = text.slice(frontmatter[0].length);
  }
  // 原生命令由文件名命名，不能用 Agent 风格的 name 别名绑定另一流程角色。
  if (metadata.name !== undefined && metadata.name !== id) throw new Error(`Command name 必须与文件名一致：${id}`);
  const prompt = text.trim();
  if (!prompt) throw new Error(`Command Prompt 不能为空：${path}`);
  if (isFlowAgentId(id) && (/\$(?:ARGUMENTS|@(?:\[\d+(?::\d*)?\])?|\d+)/.test(prompt) || /\{\{[\s\S]*?\b(?:arguments|ARGUMENTS|args)\b[\s\S]*?\}\}/.test(prompt))) {
    throw new Error(`${path}：流程命令不使用参数占位符；OMP 会在模板展开后原样追加工作包`);
  }
  const info = statSync(path);
  const command = { id, path, directory: realpathSync(dirname(path)), prompt,
    hash: createHash('sha256').update(prompt).digest('hex'),
    sourceHash: createHash('sha256').update(source).digest('hex'),
    revision: Math.floor(info.mtimeMs), updatedAt: info.mtime.toISOString(), metadata };
  externalCommandOptions(command);
  return command;
}

/** 与 OMP 原生项目命令一致：只扫描目录直属 .md。
 * 不读取 .omp/agents、全局命令或嵌套 Markdown 作为流程 Prompt。
 */
export function discoverExternalCommandPrompts(workspace: string): DetectedCommandPrompt[] {
  const root = join(workspace, '.omp', 'commands');
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a,b) => a.name.localeCompare(b.name)).map(entry => {
      const path = join(root, entry.name);
      const id = basename(entry.name, '.md');
      try { readCommandPrompt(path); return { id, path, error: null }; }
      catch (error) { return { id, path, error: error instanceof Error ? error.message : String(error) }; }
    });
}

export function externalCommandPromptPath(workspace: string, commandId: string) {
  if (!validId(commandId)) throw new Error('Command ID 无效');
  return join(workspace, '.omp', 'commands', `${commandId}.md`);
}

export function loadExternalCommandPrompt(workspace: string, commandId: string): ExternalCommandPrompt {
  const path = externalCommandPromptPath(workspace, commandId);
  const detected = discoverExternalCommandPrompts(workspace).find(command => command.id === commandId);
  if (!detected) throw new Error(`Command 定义不存在：${path}。请在当前工作目录 .omp/commands 中准备该命令。`);
  if (detected.error) throw new Error(detected.error);
  return readCommandPrompt(path);
}

export function externalCommandOptions(command: ExternalCommandPrompt): AgentExecutionOptions {
  const list = (value: unknown, field: string): string[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value.split(',').map(value=>value.trim()).filter(Boolean);
    if (Array.isArray(value) && value.every(value=>typeof value==='string')) return value.map(value=>value.trim()).filter(Boolean);
    throw new Error(`${command.path}: ${field} 必须是字符串或字符串列表`);
  };
  const models = list(command.metadata.model, 'model');
  const tools = list(command.metadata.tools, 'tools');
  const skills = list(command.metadata.skills, 'skills');
  if (models && models.length > 1) throw new Error(`${command.path}: 主流程 Command 只支持一个 model；子 Agent 的多模型策略由 OMP 自行管理`);
  const thinking = command.metadata['thinking-level'] ?? command.metadata.thinking ?? command.metadata.thinkingLevel;
  const levels = ['off','minimal','low','medium','high','xhigh','max','auto'];
  if (thinking !== undefined && (typeof thinking !== 'string' || !levels.includes(thinking))) throw new Error(`${command.path}: 无效的思考强度`);
  return { model: models?.[0], tools, skills, reasoningEffort: thinking as AgentExecutionOptions['reasoningEffort'],
    ...(isFlowAgentId(command.id)
      ? { nativeCommand: { name: command.id, path: command.path, sourceHash: command.sourceHash } }
      // 辅助模板会替换任务字段后附加；同样归 commands 管理，不占用子 Agent 定义。
      : { systemPromptFile: command.path, systemPromptText: command.prompt }),
  };
}

export function mergeExternalCommandOptions(command: ExternalCommandPrompt, defaults: AgentExecutionOptions = {}, overrides: AgentExecutionOptions = {}): AgentExecutionOptions {
  const defined = (options: AgentExecutionOptions) => Object.fromEntries(Object.entries(options).filter(([,value]) => value !== undefined));
  const external = externalCommandOptions(command);
  return { ...defined(defaults), ...defined(external), ...defined(overrides),
    nativeCommand: external.nativeCommand, systemPromptFile: external.systemPromptFile, systemPromptText: external.systemPromptText };
}
