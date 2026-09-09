export const CODE_WORKSPACE_RESOURCE = 'code:workspace' as const;
// Retained so historical execution snapshots and claims remain readable.
export const BROWSER_EXCLUSIVE_RESOURCE = 'browser:exclusive' as const;

export const RESOURCE_DEFINITIONS = {
  [CODE_WORKSPACE_RESOURCE]: { ownerScope: 'task', requiresClaim: true },
  [BROWSER_EXCLUSIVE_RESOURCE]: { ownerScope: 'execution', requiresClaim: false },
} as const;

export type ResourceKey = keyof typeof RESOURCE_DEFINITIONS;

export function resourcesForAgent(agent: string): ResourceKey[] {
  const resources: ResourceKey[] = [];
  if (['dev-agent', 'test-agent', 'direct-agent'].includes(agent)) resources.push(CODE_WORKSPACE_RESOURCE);
  return resources;
}

export function resourcesRequiringClaims(resources: readonly ResourceKey[]): ResourceKey[] {
  return resources.filter((resourceKey) => RESOURCE_DEFINITIONS[resourceKey].requiresClaim);
}
