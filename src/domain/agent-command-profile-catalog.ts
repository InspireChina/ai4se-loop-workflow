import type { AgentCommandProfile } from './agent-command-profile';

// Fixed protocol metadata: no YAML loading, application configuration or
// database initialization. Resume routing can be inspected by Root readers.
const PROFILES: AgentCommandProfile[] = [
  {
    id: 'direct',
    agent: 'direct-agent',
    pipelines: ['direct'],
    namespace: 'direct',
    draftType: 'direct',
    terminalActions: ['direct submit --summary-file <简短结论> [--result-file <完整结果>]'],
  },
  {
    id: 'idea-context',
    agent: 'idea-context-agent',
    pipelines: ['ba-intent', 'resume'],
    namespace: 'idea-context',
    draftType: 'business_analysis',
    terminalActions: ['phase complete'],
    commandChainId: 'idea-context',
  },
  {
    id: 'business-design',
    agent: 'business-design-agent',
    pipelines: ['ba-design', 'resume'],
    namespace: 'business-design',
    draftType: 'business_analysis',
    terminalActions: ['phase complete'],
    commandChainId: 'business-design',
  },
  {
    id: 'requirement-spec',
    agent: 'requirement-spec-agent',
    pipelines: ['ba-spec', 'resume'],
    namespace: 'requirement-spec',
    draftType: 'business_analysis',
    terminalActions: ['phase complete'],
    commandChainId: 'requirement-spec',
  },
  {
    id: 'spec-review',
    agent: 'spec-review-agent',
    pipelines: ['ba-review', 'resume'],
    namespace: 'spec-review',
    draftType: 'business_analysis',
    terminalActions: ['phase complete'],
    commandChainId: 'spec-review',
  },
  {
    id: 'requirement-context',
    agent: 'backlog-agent',
    pipelines: ['backlog', 'resume'],
    namespace: 'requirement-context',
    draftType: 'requirement_context',
    terminalActions: ['phase complete'],
    commandChainId: 'requirement-context',
  },
  {
    id: 'reproduction',
    agent: 'repro-agent',
    pipelines: ['repro', 'resume', 'feedback-repro'],
    namespace: 'reproduction',
    draftType: 'reproduction',
    terminalActions: ['phase complete'],
    commandChainId: 'reproduction',
  },
  {
    id: 'delivery-analysis',
    agent: 'analyst-agent',
    pipelines: ['analysis'],
    namespace: 'delivery-analysis',
    draftType: 'analysis',
    terminalActions: ['phase complete'],
    supportsResume: true,
    commandChainId: 'delivery-analysis',
  },
  {
    id: 'implementation',
    agent: 'dev-agent',
    pipelines: ['dev', 'resume'],
    namespace: 'implementation',
    draftType: 'development',
    terminalActions: ['phase complete'],
    commandChainId: 'development',
  },
  {
    id: 'verification',
    agent: 'test-agent',
    pipelines: ['test', 'resume'],
    namespace: 'verification',
    draftType: 'verification',
    terminalActions: ['phase complete'],
    commandChainId: 'verification',
  },
  {
    id: 'feedback-triage',
    agent: 'feedback-agent',
    pipelines: ['feedback-triage'],
    namespace: 'feedback',
    draftType: 'feedback',
    terminalActions: ['phase complete'],
    commandChainId: 'feedback-triage',
  },
  {
    id: 'feedback-verify',
    agent: 'feedback-agent',
    pipelines: ['feedback-verify'],
    namespace: 'feedback',
    draftType: 'feedback',
    terminalActions: ['phase complete'],
    commandChainId: 'feedback-verify',
  },
  {
    id: 'review',
    agent: 'review-agent',
    pipelines: ['review', 'feedback-report'],
    namespace: 'review',
    draftType: 'review',
    terminalActions: ['phase complete'],
    commandChainId: 'review',
  },
  {
    id: 'delivery-plan',
    agent: 'story-splitter-agent',
    pipelines: ['split', 'feedback-split'],
    namespace: 'delivery-plan',
    draftType: 'delivery_plan',
    terminalActions: ['phase complete'],
    commandChainId: 'delivery-plan',
  },
];

export function agentCommandProfile(agent: string, pipeline: string) {
  const profile = PROFILES.find((profile) =>
    profile.agent === agent
      && (profile.pipelines.includes(pipeline) || (pipeline === 'resume' && profile.supportsResume))) || null;
  return profile ? { ...profile } : null;
}

export function agentCommandProfiles() {
  return PROFILES.map((profile) => ({
    ...profile,
    pipelines: [...profile.pipelines],
    terminalActions: [...profile.terminalActions],
  }));
}
