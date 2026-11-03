import { join } from 'node:path';
import { agentCommandProfile } from './agent-command-profile';

/** 角色和 Pipeline 是固定的；Prompt 与可编辑脚本通过同名 Command 绑定。
 * 每次工作包都重新说明映射，不让模型从旧 Prompt 或文件名猜测当前链。
 */
export function workflowCommandBinding(workspace: string, role: string, pipeline: string) {
  const profile = agentCommandProfile(role, pipeline);
  if (!profile) throw new Error(`没有 Workflow Command 绑定：${role}/${pipeline}`);
  return [
    '# Workflow Command Binding',
    `- OMP Command: /${role}`,
    `- Command Prompt: ${join(workspace, '.omp', 'commands', `${role}.md`)}`,
    `- Command Script: ${join(workspace, '.omp', 'commands', `${role}.cjs`)}`,
    '- Script API: v1',
    `- Workflow Role: ${role}`,
    `- Pipeline: ${pipeline}`,
    `- Command Chain ID: ${profile.commandChainId || 'direct'}`,
    `- First tool call: loopwork ${JSON.stringify({ args: profile.draftType === 'direct' ? ['direct', 'run'] : ['status'] })}`,
    '阶段、权限和完成条件以该工具返回的当前工作包为准。不要执行脚本源码文件来绕过授权协议，也不要把 .omp/agents 中的子 Agent 定义当作本流程指令。',
  ].join('\n');
}
