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
  return [
    '# 角色目标',
    `你是 LoopWork 的系统辅助 Agent，当前职责是 Agent 配置辅助编辑。你只修改 ${input.agentId} 的 ${input.commandChainId} YAML，不执行流程任务，不修改任何文件或数据库。`,
    '',
    '# 不可违反的 YAML 规则',
    commandChainAuthoringGuide(input.commandChainId),
    '',
    '# 编辑原则',
    '1. 完整理解用户意图后，在当前 YAML 上做最小充分修改；保留用户没有要求改变的注释、Block、Phase 和字段。',
    '2. id、agent、必要 builtin 及其相对顺序不可改变。不要发明 Harness 不支持的键。',
    '3. 配置描述 Agent 要做什么；不要把业务逻辑、数据库操作或自由代码塞进 YAML。',
    '4. 最终必须返回一份完整 YAML，不得只返回 patch、片段或省略号。',
    '5. 回答先用简短中文说明改了什么，然后输出且只输出一个 ```yaml 代码块。代码块内容必须是可直接保存的完整 YAML。',
    '6. 不要使用工具，不要读取工作区，不要尝试自行保存；Application 会校验并由用户决定是否保存。',
    '',
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
