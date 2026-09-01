export type AgentCommandKind =
  | 'help'
  | 'identity'
  | 'status'
  | 'write'
  | 'transition'
  | 'terminal'
  | 'unknown';

export type AgentCommand = {
  raw: string;
  positionals: string[];
  flags: Map<string, string>;
  namespace: string | null;
  resource: string | null;
  action: string | null;
  kind: AgentCommandKind;
};

const TERMINAL_ACTIONS = new Set(['complete', 'request-input', 'fail']);

function classify(positionals: string[]) {
  if (positionals[0] === 'help') return { kind: 'help' as const, namespace: null, resource: null, action: positionals[1] || null };
  if (positionals[0] === 'whoami') return { kind: 'identity' as const, namespace: null, resource: null, action: null };

  const namespace = positionals[0] || null;
  const resource = positionals[1] || null;
  const action = positionals[2] || null;
  if (!namespace) return { kind: 'unknown' as const, namespace, resource, action };
  if (namespace === 'status' && !resource) {
    return { kind: 'status' as const, namespace: null, resource: null, action: 'status' };
  }
  if (namespace === 'phase' && resource && !action && ['complete', 'rewind'].includes(resource)) {
    return { kind: 'transition' as const, namespace, resource, action: resource };
  }
  if (['artifact', 'decision', 'check', 'runtime-input', 'metadata'].includes(namespace) && resource && !action) {
    return { kind: 'write' as const, namespace, resource, action: resource };
  }
  if (['delivery-unit', 'delivery-spec'].includes(namespace) && resource === 'current' && !action) {
    return { kind: 'status' as const, namespace, resource, action: resource };
  }
  if (resource === 'status' && !action) return { kind: 'status' as const, namespace, resource: null, action: resource };
  if (resource && !action && TERMINAL_ACTIONS.has(resource)) {
    return { kind: 'terminal' as const, namespace, resource: null, action: resource };
  }
  if (resource && action === 'complete') return { kind: 'transition' as const, namespace, resource, action };
  if (resource && action?.startsWith('reopen-')) return { kind: 'transition' as const, namespace, resource, action };
  if (resource && action) return { kind: 'write' as const, namespace, resource, action };
  return { kind: 'unknown' as const, namespace, resource, action };
}

export function parseAgentCommand(args: string[]): AgentCommand {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${name} 必须提供值`);
    flags.set(name, next);
    index += 1;
  }
  const classification = classify(positionals);
  return {
    raw: positionals.join(' '),
    positionals,
    flags,
    ...classification,
  };
}
