const statusLabels: Record<string, string> = {
  backlog: '需求梳理',
  'in repro': '问题复现',
  'in plan': '交付拆分',
  'ready for dev': '等待推进',
  'in dev': '单元推进',
  'in feedback': '反馈处理',
  'in review': '整体验收',
  ready_to_close: '等待阅读结卡',
  done: '已完成',
  cancelled: '已取消',
  blocked: '系统阻塞',
};

const agentLabels: Record<string, string> = {
  human: '用户',
  system: '系统',
  'backlog-agent': '需求梳理 Agent',
  'story-splitter-agent': '交付规划 Agent',
  'analyst-agent': '方案分析 Agent',
  'repro-agent': '问题复现 Agent',
  'dev-agent': '开发实现 Agent',
  'test-agent': '验证 Agent',
  'review-agent': '结卡报告 Agent',
  'feedback-agent': '反馈处理 Agent',
  'context-chat-agent': '上下文 Chat Agent',
};

const itemTypeLabels: Record<string, string> = {
  feature: '功能需求',
  bug: '缺陷',
  tech: '技术改进',
  intake: '待梳理',
  other: '其他',
};

const flowLabels: Record<string, string> = {
  backlog: '需求梳理',
  repro: '问题复现',
  split: '交付拆分',
  analysis: '方案分析',
  dev: '开发实现',
  test: '验证',
  review: '结卡报告',
  'feedback-triage': '反馈分流',
  'feedback-verify': '反馈验证',
  'feedback-repro': '反馈问题复现',
  'feedback-split': '反馈交付拆分',
  'feedback-report': '反馈报告修订',
  resume: '恢复推进',
};

const documentKindLabels: Record<string, string> = {
  context: '需求上下文',
  delivery_split: '交付拆分',
  analysis: '方案分析',
  repro: '问题复现',
  dev_note: '开发记录',
  test_result: '验证结果',
  review: '整体验收',
  feedback: '反馈澄清',
};

const confirmationKindLabels: Record<string, string> = {
  local: '需求级',
  analysis: '方案分析',
  test: '验证',
  review: '整体验收',
  feedback: '反馈处理',
};

const feedbackWorkTypeLabels: Record<string, string> = {
  reply: '直接回复',
  historical_correction: '历史说明',
  report_correction: '报告修订',
  bug: '问题修复',
  behavior_change: '行为修订',
  scope_addition: '范围新增',
  technical_change: '技术调整',
  learning_only: '长期建议',
};

const feedbackBatchStatusLabels: Record<string, string> = {
  triaging: '等待分组',
  waiting_for_answers: '等待澄清',
  executing: '前向处理中',
  verifying: '等待独立验证',
  reporting: '生成新版结卡报告',
  completed: '已完成',
  cancelled: '已取消',
  system_blocked: '系统阻塞',
};

export function statusLabel(status: string) {
  return statusLabels[status] || status;
}

export function agentLabel(agent: string | null | undefined) {
  return agent ? agentLabels[agent] || agent : '未分配';
}

export function itemTypeLabel(itemType: string) {
  return itemTypeLabels[itemType] || itemType;
}

export function flowLabel(flow: string | null | undefined) {
  return flow ? flowLabels[flow] || flow : '未指定流程';
}

export function documentKindLabel(kind: string) {
  if (/^review_v\d+$/.test(kind)) return `结卡报告 v${kind.slice('review_v'.length)}`;
  return documentKindLabels[kind] || kind;
}

export function confirmationKindLabel(kind: string) {
  return confirmationKindLabels[kind] || kind;
}

export function feedbackWorkTypeLabel(workType: string) {
  return feedbackWorkTypeLabels[workType] || workType;
}

export function feedbackBatchStatusLabel(status: string) {
  return feedbackBatchStatusLabels[status] || status;
}

export function deliveryUnitLabel(index: number | null | undefined) {
  return index ? `交付单元 ${index}` : '需求级';
}

export function terminologyText(value: string | null | undefined) {
  if (!value) return value || '';
  return value
    .replace(/\bStory-(\d+)\b/gi, '交付单元 $1')
    .replace(/\bStories\b/gi, '交付单元')
    .replace(/\bStory\b/gi, '交付单元')
    .replace(/\bTask\b(?!-)/gi, '需求')
    .replace(/\bApproval\b/gi, '旧版确认记录');
}
