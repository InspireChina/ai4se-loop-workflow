import { BUSINESS_ANALYSIS_AGENT_IDS } from '../domain/agent-profile';

export function taskDetailVisibility(task: {
  itemType: string;
  currentSubagent: string | null;
}) {
  const isBusinessAnalysis = task.itemType === 'business-analysis';
  const isEndToEnd = task.itemType === 'end-to-end';
  const isDirect = task.itemType === 'direct';
  const inBusinessAnalysisStage = isBusinessAnalysis
    || (isEndToEnd && BUSINESS_ANALYSIS_AGENT_IDS.includes(
      task.currentSubagent as typeof BUSINESS_ANALYSIS_AGENT_IDS[number],
    ));

  return {
    isBusinessAnalysis,
    isEndToEnd,
    isDirect,
    inBusinessAnalysisStage,
    showDeliveryWorkflow: !inBusinessAnalysisStage && !isDirect,
    showDecisionAlignment: !isDirect,
  };
}
