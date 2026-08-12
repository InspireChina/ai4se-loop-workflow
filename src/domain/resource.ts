export const CODE_WORKSPACE_RESOURCE = 'code:workspace' as const;
export const BROWSER_EXCLUSIVE_RESOURCE = 'browser:exclusive' as const;

export const RESOURCE_DEFINITIONS = {
  [CODE_WORKSPACE_RESOURCE]: { ownerScope: 'task' },
  [BROWSER_EXCLUSIVE_RESOURCE]: { ownerScope: 'execution' },
} as const;

export type ResourceKey = keyof typeof RESOURCE_DEFINITIONS;

export function resourcesForAgent(agent: string): ResourceKey[] {
  const resources: ResourceKey[] = [];
  if (['dev-agent', 'test-agent'].includes(agent)) resources.push(CODE_WORKSPACE_RESOURCE);
  if (['backlog-agent', 'repro-agent', 'dev-agent', 'test-agent'].includes(agent)) {
    resources.push(BROWSER_EXCLUSIVE_RESOURCE);
  }
  return resources;
}
