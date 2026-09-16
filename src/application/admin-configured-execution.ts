import type { AdminRuntimeConfiguration } from '../domain/admin-runtime-configuration';
import type { AdminControllerPorts, AdminExecutionCompletion } from './admin-controller';
import type { AdminManagementStore } from '../infrastructure/admin-management-store';
import { sanitizeDiagnosticText } from '../infrastructure/diagnostic-text';
import { selectRepairRuntime } from '../domain/repair-recovery-policy';
import { boundedExecutionLookup } from './bounded-execution-lookup';

/** Refresh through an optional business configuration adapter. Durable last
 * configured choices survive business DB failure and management restart.
 * There is no silent fallback to a different/default executor. */
export function createConfiguredAdminExecution(ports: {
  store: AdminManagementStore;
  refreshRuntime: () => Promise<AdminRuntimeConfiguration>;
  refreshAlternatives?: () => Promise<AdminRuntimeConfiguration[]>;
  configurationLookupTimeoutMs?: number;
  launch: (configuration: AdminRuntimeConfiguration, ...args: Parameters<AdminControllerPorts['launch']>) => ReturnType<AdminControllerPorts['launch']>;
}): AdminControllerPorts['launch'] {
  const lookupTimeoutMs = ports.configurationLookupTimeoutMs ?? 5000;
  if (!Number.isFinite(lookupTimeoutMs) || lookupTimeoutMs <= 0) throw new Error('管理 Runtime 配置读取超时必须为正数');
  const lookup = async <T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    return boundedExecutionLookup(read, signal, lookupTimeoutMs, 'Admin configuration lookup');
  };
  return async (claim, bind, signal) => {
    let configuration: AdminRuntimeConfiguration;
    try {
      const snapshot = ports.store.runtimeConfiguration();
      let refreshed: AdminRuntimeConfiguration | undefined;
      try { refreshed = await lookup(ports.refreshRuntime, signal); }
      catch (error) {
        const reason = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
        ports.store.recordEvidence(claim, 'runtime-refresh-failure', 'finding', { error: reason, cachedRevision: snapshot?.revision || null });
      }
      ports.store.readCommandSubmission(claim); // cancellation/fencing after an asynchronous read
      if (signal.aborted) throw new Error('Admin invocation cancelled before configured launch');
      const selected = refreshed
        ? ports.store.cacheRuntimeConfiguration(claim.authority, refreshed, snapshot?.revision || 0)
        : snapshot;
      if (!selected) throw new Error('没有可用的已配置管理 Runtime；不能擅自改用默认执行器');
      configuration = selected.configuration;
      let invocationSource = refreshed ? 'refreshed' : 'durable-cache';
      const decision = ports.store.recoveryDecision(claim.attempt.attemptId);
      if (decision?.switchRuntime) {
        const cached = ports.store.runtimeAlternatives();
        let alternatives = cached?.configurations || [];
        if (ports.refreshAlternatives) {
          try {
            const refreshedAlternatives = await lookup(ports.refreshAlternatives, signal);
            ports.store.readCommandSubmission(claim);
            if (signal.aborted) throw new Error('Admin invocation cancelled before alternate launch');
            alternatives = ports.store.cacheRuntimeAlternatives(claim.authority, refreshedAlternatives, cached?.revision || 0).configurations;
          } catch (error) {
            ports.store.recordEvidence(claim, 'runtime-alternatives-refresh-failure', 'finding', {
              error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)), cachedRevision: cached?.revision || null,
            });
          }
        }
        ports.store.readCommandSubmission(claim);
        if (signal.aborted) throw new Error('Admin invocation cancelled before alternate launch');
        const choice = selectRepairRuntime(configuration, alternatives, decision);
        configuration = choice.configuration;
        if (choice.changed) invocationSource = 'configured-alternative';
        ports.store.recordEvidence(claim, 'runtime-recovery-selection', 'management-action', {
          method: decision.method, changed: choice.changed, configurationId: configuration.configurationId,
          alternativesRevision: ports.store.runtimeAlternatives()?.revision || null,
          reason: choice.changed ? 'Switch to an already configured distinct invocation' : 'No distinct configured Runtime available; continue replanning, never invent a fallback',
        });
      }
      ports.store.recordEvidence(claim, 'invocation-runtime', 'finding', {
        revision: selected.revision, configuration, source: invocationSource,
      });
    } catch (error) {
      // Configuration resolution happens strictly before child invocation.
      const result: AdminExecutionCompletion = { outcome: 'failed', exitConfirmed: true,
        reason: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)) };
      return { completion: Promise.resolve(result), stop: async () => true };
    }
    // A launch adapter's rejection is NOT evidence that no child was spawned.
    // Leave its physical proof responsibility with Controller/the adapter.
    return ports.launch(configuration, claim, bind, signal);
  };
}
