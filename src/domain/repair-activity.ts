export type RepairActivityEvent = {
  name: string; phase?: 'started' | 'completed'; tool?: string; toolClass?: string;
  toolCallId?: string; input?: unknown; success?: boolean; exitCode?: number | null;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

/** Observable completed work is an investigation checkpoint, NOT proof of
 * repair or business acceptance. Output text, summaries and timestamps are
 * deliberately absent from its identity. */
export function repairOperation(event: RepairActivityEvent): string | null {
  if (!event.tool || event.tool === 'tool' || event.input === undefined || event.input === null) return null;
  const json = JSON.stringify({ tool: event.tool.toLowerCase(), input: canonical(event.input) });
  if (json.length > 64_000) return null;
  // Status and self-reported evidence are protocol bookkeeping, not actual
  // diagnosis. Repeatedly submitting a different prose finding cannot renew us.
  if (/loop-admin(?:\.cjs|-entry\.ts)?[\s\S]*(?:\bstatus\b|\bevidence\s+record\b)/i.test(json)) return null;
  return json;
}

export function createRepairActivityMonitor(ports: {
  now: () => number; timeoutMs: number; longToolTimeoutMs: number;
  initialCheckpointAt?: number;
  known: (operation: string) => boolean;
  checkpoint: (operation: string) => boolean;
}) {
  for (const limit of [ports.timeoutMs, ports.longToolTimeoutMs]) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('Repair activity limits must be positive');
  }
  if(ports.initialCheckpointAt!==undefined&&!Number.isFinite(ports.initialCheckpointAt))throw new Error('Activity checkpoint time must be finite');
  let lastCheckpoint = ports.now();
  let begun = false;
  let longDeadline: number | null = null;
  const calls = new Map<string, { operation: string; deadline: number | null }>();
  const started = new Set<string>();
  const completed = new Set<string>();
  const graced = new Set<string>();
  return {
    begin() { if (!begun) { begun = true; lastCheckpoint = Math.min(ports.now(),ports.initialCheckpointAt??ports.now()); } },
    observe(event: RepairActivityEvent) {
      if (event.name !== 'loop.agent.tool') return;
      if (event.phase === 'started') {
        const operation = repairOperation(event);
        if (!operation || !event.toolCallId || calls.has(event.toolCallId)) return;
        if (started.size >= 5000 || calls.size >= 5000) throw new Error('Repair activity capacity exceeded without terminal submission');
        const fresh = !graced.has(operation) && ports.now()-lastCheckpoint<ports.timeoutMs;
        started.add(operation);
        const shell = event.toolClass === 'shell';
        if (shell) graced.add(operation);
        if (fresh && shell && longDeadline === null) longDeadline = ports.now() + ports.longToolTimeoutMs;
        calls.set(event.toolCallId, { operation,
          deadline: fresh && shell ? longDeadline : null });
        return;
      }
      if (event.phase !== 'completed') return;
      const call = event.toolCallId ? calls.get(event.toolCallId) : undefined;
      if (event.toolCallId) calls.delete(event.toolCallId);
      const operation = call?.operation || repairOperation(event);
      if (!operation || event.success !== true || (event.exitCode != null && event.exitCode !== 0)) return;
      if (completed.has(operation)) return;
      if (completed.size >= 5000) throw new Error('Repair activity capacity exceeded without terminal submission');
      completed.add(operation);
      if (ports.known(operation)) return;
      // Some runtimes report successful tool completion but no numeric shell
      // exit code. This is activity only, never an independently verified pass.
      if (ports.checkpoint(operation)) { lastCheckpoint = ports.now(); longDeadline = null; graced.clear(); }
    },
    failure() {
      if (!begun) return null; // The invocation's startup limit owns initial silence.
      const now = ports.now();
      if (now - lastCheckpoint < ports.timeoutMs) return null;
      // Earliest pending lease wins; emitting more started IDs cannot extend
      // the oldest long-running command indefinitely.
      const deadlines = [...calls.values()].flatMap(call => call.deadline === null ? [] : [call.deadline]);
      if (deadlines.length && now < Math.min(...deadlines)) return null;
      return 'Admin investigation stalled: no new completed work checkpoint within the activity window';
    },
  };
}
