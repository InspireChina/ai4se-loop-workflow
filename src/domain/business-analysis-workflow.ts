export const BUSINESS_ANALYSIS_AGENT_IDS = [
  'idea-context-agent',
  'business-design-agent',
  'requirement-spec-agent',
  'spec-review-agent',
] as const;

export type BusinessAnalysisAgentId = typeof BUSINESS_ANALYSIS_AGENT_IDS[number];

export type BusinessAnalysisPhaseDefinition = {
  label: string;
  objective: string;
  required: string[];
  prohibited: string[];
  submit: string | null;
};

export const BUSINESS_ANALYSIS_WORKFLOWS: Record<BusinessAnalysisAgentId, {
  namespace: string;
  phases: readonly string[];
  definitions: Record<string, BusinessAnalysisPhaseDefinition>;
}> = {
  'idea-context-agent': {
    namespace: 'idea-context',
    phases: ['discovery', 'clarification_proposal', 'clarification_resolution', 'synthesis', 'finalize'],
    definitions: {
      discovery: {
        label: 'DISCOVERY',
        objective: '调查原始想法和可获得资料，建立问题、参与者、业务情境、目标、约束、术语以及事实与假设边界。',
        required: ['完整调查摘要', '事实、假设和未知项', '可能改变需求意图的歧义候选'],
        prohibited: ['设计业务方案', '询问可调查事实', '编写最终需求规格'],
        submit: 'idea-context discovery complete',
      },
      clarification_proposal: {
        label: 'CLARIFICATION PROPOSAL',
        objective: '批量提出当前活动层级中会改变需求意图的全部问题；没有实质歧义时提交空 questions。',
        required: ['问题树 JSON', '每个问题的选项、后果、推荐与激活条件'],
        prohibited: ['回答问题', '把方案选择包装成意图问题'],
        submit: 'idea-context clarification-proposal complete',
      },
      clarification_resolution: {
        label: 'CLARIFICATION RESOLUTION',
        objective: '读取用户回答，关闭当前活动问题，剪除未命中分支；只有自定义答案产生新歧义时才回到提议。',
        required: ['有效答案的语义归纳', 'Active Intent Path', '废弃分支说明'],
        prohibited: ['替用户回答意图歧义', '把废弃分支带入综合产物'],
        submit: 'idea-context clarification-resolution complete',
      },
      synthesis: {
        label: 'SYNTHESIS',
        objective: '形成完整需求意图简报。',
        required: ['问题、参与者、目标、成功结果', '硬约束、权威资料、排除项和已确认假设'],
        prohibited: ['具体产品方案', '详细业务规则', '技术实现'],
        submit: 'idea-context synthesis complete',
      },
      finalize: {
        label: 'FINALIZE',
        objective: '复核需求意图简报可以作为唯一、无隐藏歧义的业务方案输入。',
        required: ['完整且自洽的需求意图简报'],
        prohibited: ['新增未确认语义'],
        submit: 'idea-context complete',
      },
    },
  },
  'business-design-agent': {
    namespace: 'business-design',
    phases: ['exploration', 'decision_proposal', 'decision_resolution', 'solution', 'finalize'],
    definitions: {
      exploration: {
        label: 'EXPLORATION',
        objective: '围绕已确认需求意图完整探索参与者任务、场景、流程、规则、异常、候选方案和范围取舍。',
        required: ['业务场景与候选方案', '主异常流程', '需要决策的实质分叉'],
        prohibited: ['关闭决策', '写技术方案', '改变需求意图'],
        submit: 'business-design exploration complete',
      },
      decision_proposal: {
        label: 'DECISION PROPOSAL',
        objective: '一次建立完整业务决策树，只提出不回答。',
        required: ['问题树 JSON', '互斥选项、后果、推荐、建议决定权和依赖'],
        prohibited: ['关闭节点', '请求用户批准整份方案'],
        submit: 'business-design decision-proposal complete',
      },
      decision_resolution: {
        label: 'DECISION RESOLUTION',
        objective: '按用户决定和本工作包提供的自动决策强度关闭活动节点。',
        required: ['Agent 决定及依据', '需要 HUMAN 确认的 key', '有效决策路径'],
        prohibited: ['提出新决策', '覆盖用户决定', '越过自动决策策略'],
        submit: 'business-design decision-resolution complete',
      },
      solution: {
        label: 'SOLUTION',
        objective: '把需求意图和 Active Decision Path 聚合为唯一业务方案。',
        required: ['参与者、目标行为、流程、场景、规则', '范围边界、排除项和成功结果'],
        prohibited: ['保留多个互斥结果', '写技术架构或代码设计'],
        submit: 'business-design solution complete',
      },
      finalize: {
        label: 'FINALIZE',
        objective: '复核业务方案完整覆盖需求意图且没有隐藏业务分叉。',
        required: ['完整且唯一的业务方案'],
        prohibited: ['新增未登记决定'],
        submit: 'business-design complete',
      },
    },
  },
  'requirement-spec-agent': {
    namespace: 'requirement-spec',
    phases: ['composition', 'verification', 'finalize'],
    definitions: {
      composition: {
        label: 'COMPOSITION',
        objective: '一次编写完整需求规格说明书。',
        required: ['AS IS、TO BE、ACTORS、SCENARIOS、BUSINESS RULES', 'SCOPE、OUT OF SCOPE、ACCEPTANCE、DEPENDENCIES、ASSUMPTIONS'],
        prohibited: ['重新设计方案', '加入未决定规则', '写技术实现'],
        submit: 'requirement-spec composition complete',
      },
      verification: {
        label: 'VERIFICATION',
        objective: '整体检查来源覆盖、决策继承、章节一致性、场景完整性、范围和验收可验证性。',
        required: ['通过整体校验且已修正表达缺陷的完整需求规格说明书', '无法自行修正的上游缺口必须改用 return-gap'],
        prohibited: ['自行回答业务缺口'],
        submit: 'requirement-spec verification complete',
      },
      finalize: {
        label: 'FINALIZE',
        objective: '提交通过当前版本验证的完整需求规格说明书。',
        required: ['最终需求规格说明书'],
        prohibited: ['退回未修正的 COMPOSITION 初稿', '只提交摘要或验证报告'],
        submit: 'requirement-spec complete',
      },
    },
  },
  'spec-review-agent': {
    namespace: 'spec-review',
    phases: ['inspection', 'classification', 'verdict'],
    definitions: {
      inspection: {
        label: 'INSPECTION',
        objective: '独立对照全部权威业务输入，检查目标、决定、场景、规则、范围、验收和来源追踪。',
        required: ['逐主题审查发现及证据'],
        prohibited: ['直接改写上游决定', '检查代码实现'],
        submit: 'spec-review inspection complete',
      },
      classification: {
        label: 'CLASSIFICATION',
        objective: '合并重复发现并把阻断缺口分类为 intent、business_design 或 specification。',
        required: ['结构化 gaps JSON；没有缺口时为空数组'],
        prohibited: ['自行回答缺口', '保留不影响规格成立的噪声'],
        submit: 'spec-review classification complete',
      },
      verdict: {
        label: 'VERDICT',
        objective: '无缺口时批准完整需求规格；有缺口时返回唯一职责目标。',
        required: ['批准后的完整需求规格，或结构化回流理由'],
        prohibited: ['同时批准和回流', '只提交审查摘要作为最终规格'],
        submit: null,
      },
    },
  },
};

export function businessAnalysisWorkflow(agent: string) {
  return BUSINESS_ANALYSIS_WORKFLOWS[agent as BusinessAnalysisAgentId] || null;
}

export function businessAnalysisPhaseSequence(agent: BusinessAnalysisAgentId) {
  return BUSINESS_ANALYSIS_WORKFLOWS[agent].phases
    .map((phase) => BUSINESS_ANALYSIS_WORKFLOWS[agent].definitions[phase].label)
    .join(' → ');
}
