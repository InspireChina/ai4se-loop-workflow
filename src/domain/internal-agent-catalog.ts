export type InternalAgentDefinition = {
  id: string;
  label: string;
  description: string;
  runtimeIdentity: string;
  trigger: string;
  authority: string;
  editable: false;
};

/**
 * Model-backed roles that exist outside the configurable workflow Agent list.
 * These definitions describe v0.1 capabilities only; they are intentionally
 * read-only because their prompts and permissions are owned by the Harness.
 */
export const INTERNAL_AGENT_DEFINITIONS = [
  {
    id: 'system-assistance-agent',
    label: '系统辅助 Agent',
    description: '在 Test Agent 缺少运行条件或可靠证据时先行调查，最多自动尝试三次，再转交人工。',
    runtimeIdentity: 'system-assistance-agent · verification-assistance',
    trigger: 'Runner 发现待处理的验证协助请求',
    authority: '只能处理验证协助并提交答复；不能直接改写 Dev/Test 结论',
    editable: false,
  },
  {
    id: 'prompt-evolution-agent',
    label: 'Prompt 演化 Agent',
    description: '从已结束的真实执行中提取观察，生成受 Canary 约束的 Prompt Candidate。',
    runtimeIdentity: 'prompt-evolution-agent · evolution',
    trigger: '项目开启自动演化且存在合格执行证据',
    authority: '后台旁路运行；不能推进业务流程或绕过 Harness',
    editable: false,
  },
  {
    id: 'context-chat-agent',
    label: '任务上下文 Chat Agent',
    description: '读取需求最新上下文并回答问题，可提交受限的结构化变更请求。',
    runtimeIdentity: 'context-chat-agent · context-chat-execution',
    trigger: '用户在需求详情的上下文对话中发送消息',
    authority: '禁止直接修改运行权限、Agent 配置或绕过业务命令边界',
    editable: false,
  },
  {
    id: 'agent-configuration-assistant',
    label: 'Agent 配置助手',
    description: '根据用户要求生成命令链 YAML 修改草稿，由页面校验后再交给用户保存。',
    runtimeIdentity: 'system assistance invocation · configuration-chat',
    trigger: '用户在 Agent 配置编辑器中请求 AI 修改',
    authority: '只返回草稿；不能直接保存配置、修改文件或写数据库',
    editable: false,
  },
] as const satisfies readonly InternalAgentDefinition[];
