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
 * Model-backed system roles that intentionally sit outside FLOW_AGENT_IDS.
 * They are shown in the Agent catalog for auditability, but their prompts,
 * permissions and scheduling contracts are owned by the Harness and cannot be
 * edited as project Agent configuration.
 */
export const INTERNAL_AGENT_DEFINITIONS = [
  {
    id: 'system-assistance-agent',
    label: '系统辅助 / 仲裁 Agent',
    description: '处理普通流程介入、验证协助和历史仲裁调查；新的 Agent 自身故障由 Admin 接管。',
    runtimeIdentity: 'system-assistance-agent · intervention',
    trigger: 'Runner 发现可领取的普通介入',
    authority: '只能使用受限介入命令；自动执行不能直接完成 Dev/Test',
    editable: false,
  },
  {
    id: 'admin-repair-agent',
    label: 'Admin 修复 Agent',
    description: '调查 Agent 故障、接管资源、实际修复并提交独立验收请求，不依赖业务 Runner 槽位。',
    runtimeIdentity: 'system-assistance-agent · admin',
    trigger: 'Admin Controller 领取 RepairCase',
    authority: '受监督权、代次、资源所有权、版本和进程退出屏障约束',
    editable: false,
  },
  {
    id: 'independent-repair-verification-agent',
    label: '独立修复验收 Agent',
    description: '根据冻结的原始故障和修复版本编写独立验收计划；最终通过由原生 Verification Worker 执行确认。',
    runtimeIdentity: 'test-agent · independent-repair-verification',
    trigger: 'RepairCase 进入 verifying',
    authority: '无 Admin 或业务写凭据；不能用模型总结直接判定通过',
    editable: false,
  },
  {
    id: 'prompt-evolution-agent',
    label: 'Prompt 演化 Agent',
    description: '从已经结束的真实执行中提取可复用观察，生成 Memory 提升或 Prompt Candidate。',
    runtimeIdentity: 'prompt-evolution-agent · evolution',
    trigger: '项目开启自动演化且存在合格执行证据',
    authority: '后台运行；不能推进业务 Work Item，失败也不阻塞业务流程',
    editable: false,
  },
  {
    id: 'context-chat-agent',
    label: '任务上下文 Chat Agent',
    description: '在需求详情的上下文对话中读取最新事实、回答问题，并可提交受限的结构化变更请求。',
    runtimeIdentity: 'context-chat-agent · context-chat-execution',
    trigger: '用户在需求上下文对话中发送消息',
    authority: '独立于 Runner；禁止直接改写 Loop 状态、权限和 Agent 配置',
    editable: false,
  },
  {
    id: 'agent-configuration-assistant',
    label: 'Agent 配置助手',
    description: '根据用户要求生成命令链 YAML 修改草稿，交给 Harness 校验后由用户决定是否保存。',
    runtimeIdentity: '临时 system assistance invocation',
    trigger: '用户在 Agent 配置编辑器中请求 AI 修改',
    authority: '只返回草稿；不能直接保存配置、修改文件或写数据库',
    editable: false,
  },
] as const satisfies readonly InternalAgentDefinition[];
