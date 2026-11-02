import { loadExternalAgent } from '../infrastructure/external-agents';
import { getConfiguredWorkspaceRoot } from '../infrastructure/database';
import { z } from 'zod';
import { commandChainCatalogItem } from '../domain/command-chain-catalog';
import { commandChainAuthoringGuide, parseCommandChainDefinition } from '../domain/command-chain-definition';

export type AgentConfigurationChatMessage = { role: 'user' | 'assistant'; content: string };

const messageSchema = z.string().trim().min(1, '请输入修改要求').max(20_000, '单条消息不能超过 20000 个字符');
const historySchema = z.array(z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(40_000),
})).max(20);

export function buildAgentConfigurationChatPrompt(input: {
  agentId: string;
  commandChainId: string;
  yaml: string;
  message: unknown;
  history?: unknown;
  repairError?: string;
  invalidOutput?: string;
}) {
  const catalog = commandChainCatalogItem(input.commandChainId);
  if (!catalog || catalog.agentId !== input.agentId) throw new Error('命令链不属于当前 Agent');
  const message = messageSchema.parse(input.message);
  const history = historySchema.parse(input.history || []);
  const transcript = history.length
    ? history.map((item) => `${item.role === 'user' ? '用户' : '系统辅助 Agent'}：${item.content}`).join('\n\n')
    : '无；这是本次编辑会话的第一轮。';
  const role = loadExternalAgent(getConfiguredWorkspaceRoot(), 'agent-configuration-assistant').prompt
    .replaceAll('{{agent_id}}', input.agentId).replaceAll('{{command_chain_id}}', input.commandChainId)
    .replaceAll('{{authoring_guide}}', commandChainAuthoringGuide(input.commandChainId));
  return [role,
    `# 当前配置：${input.agentId} / ${input.commandChainId}`,
    '# Harness YAML 契约',
    commandChainAuthoringGuide(input.commandChainId),
    '# 当前会话',
    transcript,
    '',
    '# 当前完整 YAML',
    '```yaml',
    input.yaml.trim(),
    '```',
    '',
    '# 本轮用户要求',
    message,
    ...(input.repairError ? [
      '',
      '# 上一次输出未通过 Harness 校验',
      input.repairError,
      '请修复错误，仍然返回完整 YAML。以下是上一次无效输出：',
      input.invalidOutput || '',
    ] : []),
  ].join('\n');
}

export function extractAgentConfigurationYaml(output: string) {
  const matches = [...output.matchAll(/```ya?ml\s*\n([\s\S]*?)```/giu)];
  const yaml = matches.at(-1)?.[1]?.trim();
  if (!yaml) throw new Error('系统辅助 Agent 未返回完整 YAML 代码块');
  return yaml + '\n';
}

export function validateAgentConfigurationChatOutput(commandChainId: string, output: string) {
  const yaml = extractAgentConfigurationYaml(output);
  parseCommandChainDefinition(commandChainId, yaml);
  const explanation = output.replace(/```ya?ml\s*\n[\s\S]*?```/giu, '').trim() || '已根据要求更新配置。';
  return { yaml, explanation };
}
