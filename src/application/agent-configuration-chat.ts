import { loadExternalCommandPrompt } from '../infrastructure/external-command-prompts';
import { getConfiguredWorkspaceRoot } from '../infrastructure/database';
import { z } from 'zod';
import { getAgentCommandFile } from './agent-configurations';
import { validateWorkspaceScript } from '../infrastructure/workspace-scripts';

export type AgentConfigurationChatMessage = { role: 'user' | 'assistant'; content: string };
const messageSchema = z.string().trim().min(1, '请输入修改要求').max(20_000);
const historySchema = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(400_000) })).max(20);

export function buildAgentConfigurationChatPrompt(input: {
  agentId: string; relativePath: string; content: string; message: unknown; history?: unknown;
  repairError?: string; invalidOutput?: string;
}) {
  const source = getAgentCommandFile(input.agentId);
  if (!source.files.some(file => file.relativePath === input.relativePath)) throw new Error('脚本不属于当前 Agent 的入口或共享实现');
  const message = messageSchema.parse(input.message);
  const history = historySchema.parse(input.history || []);
  const role = loadExternalCommandPrompt(getConfiguredWorkspaceRoot(), 'agent-configuration-assistant').prompt;
  return [role,
    `# 当前 Agent：${input.agentId}`, `# 当前源码：.omp/commands/${input.relativePath}`,
    '# 调度接口 v1',
    'Agent 入口导出 apiVersion: 1、agent、describe(host)、initialize(runtime, db, execution, draft)、execute(runtime, invocation)、validate(context)、result(context)、restore(runtime, db, source, target)、help(runtime)。validate 返回错误字符串数组，result 返回结构化 AgentResult。Backlog 的 project 保留上下文投影。Direct 保留 executeDirect(runtime, invocation) 与 help。',
    'describe(host) 同步返回原有角色的命令链；host.define 可复用同目录 workflow/definitions.cjs 的原始阶段实现。共享 runtime 文件导出注入 Harness 能力的工厂。',
    '保留固定角色、必要入口及现有 Workflow 的调度语义。修改指定文件的实际函数逻辑，不能伪造执行结果或把令牌写入源码。',
    '# 当前会话', history.map(item => `${item.role}：${item.content}`).join('\n\n') || '这是第一轮。',
    '# 当前完整脚本', '```javascript', input.content, '```',
    '# 本轮修改要求', message,
    ...(input.repairError ? ['# 上一次输出的语法错误', input.repairError, input.invalidOutput || ''] : []),
  ].join('\n');
}

export function extractAgentConfigurationScript(output: string) {
  const matches = [...output.matchAll(/^```(?:javascript|js|cjs)\s*\n([\s\S]*?)^```\s*$/gimu)];
  const content = matches.at(-1)?.[1];
  if (!content?.trim()) throw new Error('辅助 Agent 未返回完整 JavaScript 源码代码块');
  return content.trimEnd() + '\n';
}

export function validateAgentConfigurationChatOutput(_agentId: string, output: string) {
  const content = extractAgentConfigurationScript(output);
  validateWorkspaceScript(content);
  const explanation = output.replace(/^```(?:javascript|js|cjs)\s*\n[\s\S]*?^```\s*$/gimu, '').trim() || '已生成脚本草稿。';
  return { content, explanation };
}
