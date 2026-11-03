import { isFlowAgentId } from '../domain/agent-profile';
import { getConfiguredWorkspaceRoot } from '../infrastructure/database';
import { externalCommandChainPath, loadExternalCommandChains, type ExternalCommandChainDocument } from '../infrastructure/external-command-chains';
import { workspaceScriptSources, validateWorkspaceScript, saveWorkspaceScript, type WorkspaceScriptSource } from '../infrastructure/workspace-scripts';

export type AgentCommandFile = {
  agentId: string; path: string; hash: string; updatedAt: string | null; error: string | null;
  files: WorkspaceScriptSource[]; documents: ExternalCommandChainDocument[];
};

export function getAgentCommandFile(agentId: string): AgentCommandFile {
  if (!isFlowAgentId(agentId)) throw new Error(`未知 Agent：${agentId}`);
  const workspace = getConfiguredWorkspaceRoot();
  const result: AgentCommandFile = { agentId, path: externalCommandChainPath(workspace, agentId), hash: '', updatedAt: null, error: null, files: [], documents: [] };
  try {
    const shared = ['workflow/definitions.cjs', agentId === 'direct-agent' ? 'workflow/direct-runtime.cjs' : 'workflow/command-chain-runtime.cjs'];
    result.files = workspaceScriptSources(workspace).filter(file => file.relativePath === `${agentId}.cjs` || shared.includes(file.relativePath))
      .sort((a,b) => Number(b.relativePath === `${agentId}.cjs`) - Number(a.relativePath === `${agentId}.cjs`));
    result.hash = result.files.map(file => file.hash).join(':');
    const source = loadExternalCommandChains(workspace, agentId);
    return { ...source, files: result.files, error: null };
  } catch (error) {
    return { ...result, error: error instanceof Error ? error.message : String(error) };
  }
}

export function validateAgentCommandFile(_agentId: string, content: unknown) {
  return validateWorkspaceScript(content);
}

export function saveAgentCommandScript(agentId: string, input: { relativePath: unknown; content: unknown; expectedHash: unknown }) {
  const source = getAgentCommandFile(agentId);
  if (!source.files.some(file => file.relativePath === input.relativePath)) throw new Error('该文件不属于当前 Agent 的入口或共享实现');
  saveWorkspaceScript(getConfiguredWorkspaceRoot(), input.relativePath, input.content, input.expectedHash);
  return getAgentCommandFile(agentId);
}

export function activeAgentConfigurationContextAdapter(agentId: string) {
  if (!isFlowAgentId(agentId)) return null;
  const source = loadExternalCommandChains(getConfiguredWorkspaceRoot(), agentId);
  for (const document of source.documents) {
    if (Object.values(document.definition.artifacts).some(artifact => artifact.type === 'repository' && artifact.adapter === 'openspec')) return 'openspec';
  }
  return null;
}
