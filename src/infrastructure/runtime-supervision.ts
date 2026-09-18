import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLoopRunLifecycle, type LifecycleCommand, type LifecycleReceipt, type LoopRunLifecycleOptions } from '../application/loop-run-lifecycle';
import { createAdminController, type AdminControllerPorts } from '../application/admin-controller';
import { createRuntimeSupervisionHost } from '../application/runtime-supervision-host';
import { createConfiguredAdminExecution } from '../application/admin-configured-execution';
import { createAdminManagedActions } from '../application/admin-managed-actions';
import { createRepairObservationBridge } from '../application/repair-observation-bridge';
import { acknowledgeRepairObservationInDb, pendingRepairObservationsInDb } from '../application/repair-observation-outbox';
import { acquireRepairTakeover } from '../application/repair-takeover';
import { agentExecutionOptions, getAgentExecutorSettings, listSystemRuntimeConfigurations } from '../application/project-settings';
import type { AdminRuntimeConfiguration } from '../domain/admin-runtime-configuration';
import { AdminManagementStore } from './admin-management-store';
import { confirmAdminAttemptStopped, createAdminExecutionLauncher } from './admin-execution';
import { getAgentExecutor, type AgentExecutor } from './agent-executor';
import { resolveAgentExecutionLimits } from './agent-execution-limits';
import { createLangfuseTelemetry } from './langfuse';
import { databaseConnection } from './database';
import { sanitizeDiagnosticText } from './diagnostic-text';
import { createNativeAdminVerification, type NativeAdminVerificationPorts } from './native-admin-verification';
import { createAdminHandoffs } from '../application/admin-handoff';
import { handoffVerifiedRepair, observeRepairHandoffProgressInDb } from '../application/repair-handoff';
import { readRepairWorkspaceVersion } from './repair-workspace-version';
import { createDefaultRepairVerification } from './default-repair-verification';
import { createIndependentVerificationPreparation } from './independent-verification-preparation';
import { assertIndependentVerificationWorkspaceInDb } from '../application/independent-verification-workspace';
import { observeRepairBusinessReadinessInDb, holdStalledRepairBusinessInDb } from '../application/repair-business-watch';
import { createRuntimeIdleSleep, type IdleSleepInhibitor } from '../application/runtime-idle-sleep';
import { createNativeIdleSleepInhibitor } from './idle-sleep-inhibitor';
import { runtimeActivationTarget, type RuntimeUpdateAuthority } from '../domain/runtime-update';
import { reconcileAdminBusinessTakeovers } from './admin-business-operations';

export { createLoopRunLifecycle } from '../application/loop-run-lifecycle';

/** Production composition only. Controller/command/invocation core continue
 * to use independent storage and injected business capabilities. */
export function createManagedLoopRunLifecycle(options: LoopRunLifecycleOptions & {
  /** Electron injects its native blocker; standalone uses an OS helper. */
  inhibitIdleSleep?: IdleSleepInhibitor;
  management?: {
    store?: AdminManagementStore;
    refreshRuntime?: () => Promise<AdminRuntimeConfiguration>;
    refreshAlternatives?: () => Promise<AdminRuntimeConfiguration[]>;
    launch?: AdminControllerPorts['launch'];
    launchVerification?: AdminControllerPorts['launch'];
    resolveVerificationPlan?: NativeAdminVerificationPorts['resolvePlan'];
    readVerificationVersion?: (workspaceRoot: string) => Promise<string>;
    resolveExecutor?: (id: AdminRuntimeConfiguration['executorId']) => AgentExecutor;
    confirmStopped?: AdminControllerPorts['confirmStopped'];
  };
}) {
  const appRoot = resolve(process.env.LOOP_APP_ROOT || process.cwd());
  const dataRoot = resolve(process.env.LOOP_DATA_ROOT || join(appRoot, 'data'));
  const store = options.management?.store || new AdminManagementStore(join(dataRoot, 'admin-management.db'));
  const diagnosticWorkspace = join(dataRoot, 'admin', 'workspace');
  mkdirSync(diagnosticWorkspace, { recursive: true });
  let version = options.installedVersion || 'unknown';
  if (version === 'unknown') {
    try { version = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version || 'unknown'; } catch { /* preserve unknown provenance */ }
  }
  const sourceId = createHash('sha256').update(resolve(store.filename)).digest('hex');
  const log = (error: unknown) => {
    const message = sanitizeDiagnosticText(error instanceof Error ? error.stack || error.message : String(error));
    void appendFile(join(dataRoot, 'admin', 'host.log'), `${new Date().toISOString()} ${message}\n`).catch(() => undefined);
  };
  const reportBusinessFailure = (error: unknown, phase: string) => {
    log(error);
    const message = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
    store.observe({ observationId: `host:${randomUUID()}`, scope: 'runtime', scopeKey: `business:${sourceId}`,
      fingerprint: createHash('sha256').update(message).digest('hex'), sourceVersion: version, origin: 'runtime',
      summary: `Business host ${phase} failed: ${message}`, evidence: {
        phase, error: { message, stack: error instanceof Error ? sanitizeDiagnosticText(error.stack || '') : null },
        host: { ownerId: options.ownerId, pid: process.pid, appRoot, dataRoot },
      } });
  };
  const refreshRuntime = options.management?.refreshRuntime || (async () => {
    const settings = await getAgentExecutorSettings();
    return { configurationId: settings.configurationId, sourceVersion: version,
      executorId: settings.executorId, executionOptions: agentExecutionOptions(settings) };
  });
  const business = createLoopRunLifecycle({ ...options, readManagedIntent: () => store.control().desired_intent,
    isManagedSuspended: () => store.control().management_mode !== 'normal', isExternalUpdatePending: () => Boolean(store.activeRuntimeUpdate()) });
  const bridge = createRepairObservationBridge({
    pending: async () => pendingRepairObservationsInDb(await databaseConnection()).map(row => JSON.parse(row.observation_json)),
    observe: observation => store.observe(observation),
    acknowledge: async (observationId, caseId) => acknowledgeRepairObservationInDb(await databaseConnection(), observationId, caseId),
  });
  const management = createAdminController({ store, ownerId: options.ownerId,
    launchVerification: options.management?.launchVerification || (options.management?.resolveVerificationPlan
      ? createNativeAdminVerification({ store, appRoot, resolvePlan: options.management.resolveVerificationPlan })
      : createDefaultRepairVerification({ store, appRoot,
        assertWorkspace: async (caseId, input) => assertIndependentVerificationWorkspaceInDb(await databaseConnection(), caseId, input),
        prepare: createConfiguredAdminExecution({ store, refreshRuntime,
        launch: (configuration, ...args) => createIndependentVerificationPreparation({ store, appRoot, dataRoot,
          executor: (options.management?.resolveExecutor || getAgentExecutor)(configuration.executorId),
          executionOptions: configuration.executionOptions, limits: resolveAgentExecutionLimits(),
        })(...args),
      }) })),
    confirmStopped: options.management?.confirmStopped || confirmAdminAttemptStopped,
    launch: options.management?.launch || createConfiguredAdminExecution({ store, refreshRuntime,
      refreshAlternatives: options.management?.refreshAlternatives || (async () => listSystemRuntimeConfigurations().map(settings => ({
        configurationId: settings.configurationId, sourceVersion: version, executorId: settings.executorId,
        executionOptions: agentExecutionOptions(settings),
      }))),
      launch: (configuration, ...args) => createAdminExecutionLauncher({ store, appRoot, dataRoot,
        workspaceRoot: diagnosticWorkspace, executor: (options.management?.resolveExecutor || getAgentExecutor)(configuration.executorId),
        executionOptions: configuration.executionOptions, limits: resolveAgentExecutionLimits(),
        telemetry: createLangfuseTelemetry({ env: { LANGFUSE_ENABLED: 'false' } }),
      })(...args),
    }),
    discover: async () => {
      // Seed choices while healthy, even when there is no fault yet. A later
      // corrupted business/configuration DB cannot erase the repair runtime.
      const snapshot = store.runtimeConfiguration();
      try {
        const configuration = await refreshRuntime();
        const control = store.control();
        if (control.owner_id === options.ownerId && control.desired_intent === 'running' && control.management_mode === 'normal') {
          store.cacheRuntimeConfiguration({ ownerId: options.ownerId, token: control.fencing_token }, configuration, snapshot?.revision || 0);
        }
      } catch (error) { reportBusinessFailure(error, 'configuration'); }
      try { return await bridge(); }
      catch (error) { reportBusinessFailure(error, 'discovery'); return 0; }
    },
    reconcileTakeovers: async authority => {
      const db = await databaseConnection();
      return reconcileAdminBusinessTakeovers({db,store,authority});
    },
    manageActions: createAdminManagedActions({ store,
      takeover: async (target, assertCurrent, previousOwnerStopped) => acquireRepairTakeover({
        db: await databaseConnection(), target, assertCurrent, previousOwnerStopped,
      }),
    }),
    manageFollowups: createAdminHandoffs({ store, onError: log,
      handoff: async (target, assertCurrent) => handoffVerifiedRepair({ db: await databaseConnection(), target, assertCurrent,
        readVersion: options.management?.readVerificationVersion || (root => readRepairWorkspaceVersion(root, { assertCurrent })),
      }),
      observeProgress: async receipt => {
        const db = await databaseConnection();
        const readCurrent = () => observeRepairHandoffProgressInDb(db, receipt);
        return { progress: readCurrent(), readCurrent, readiness: observeRepairBusinessReadinessInDb(db, receipt) };
      },
      holdStalled: async (receipt, fingerprint, assertCurrent) => {
        const db = await databaseConnection();
        const observation = holdStalledRepairBusinessInDb(db, receipt, fingerprint, assertCurrent);
        return observation ? { observation,
          acknowledge: async () => acknowledgeRepairObservationInDb(db, observation.observationId, receipt.target.caseId) } : null;
      },
    }),
    onError: log,
  });
  const trigger = { source: { adapter: options.adapter, instanceId: options.ownerId }, trigger: 'manual-reconcile' as const };
  let lastReceipt: LifecycleReceipt | undefined;
  let shutdown: Promise<void> | undefined;
  const idleSleep = createRuntimeIdleSleep({
    readKey: () => {
      const control = store.control();
      return control.desired_intent === 'running' && control.management_mode === 'normal'
        && control.owner_id === options.ownerId && control.expires_at > Date.now()
        ? `${control.intent_revision}:${control.fencing_token}` : null;
    },
    acquire: options.inhibitIdleSleep || createNativeIdleSleepInhibitor(),
    onError: log,
  });
  const host = createRuntimeSupervisionHost({ store, management,
    backgroundManagement:process.env.LOOP_RUNTIME_SAFETY==='standard',
    idleSleep,
    business: {
      initialize: async () => {
        if (store.control().intent_revision === 0) {
          const existing = await business.status();
          store.initializeIntentFromBusiness(existing.intent.desired);
        }
        await business.start();
        if (options.installedVersion && !store.activeRuntimeUpdate() && (await business.status()).mode.kind === 'normal') {
          store.setUpdateSilence(false, `restart:${options.ownerId}`);
        }
      },
      applyIntent: async intent => {
        lastReceipt = undefined;
        lastReceipt = await business.command({ requestId: `managed-intent:${sourceId}:${intent.revision}`,
          source: { adapter: options.adapter, instanceId: options.ownerId, actor: 'host' },
          action: intent.desired === 'running' ? { kind: 'start' } : { kind: 'stop', reason: 'user-stop' },
        });
        // Replaying a saved command after restart must still reconcile actual
        // processes; its receipt alone does not prove the Runner is healthy.
        if (lastReceipt.outcome !== 'update-in-progress') lastReceipt = await business.reconcile(trigger);
      },
      shutdown: () => business.shutdown(true),
    }, reportBusinessFailure,
  });
  const residual = () => store.attempts().filter(attempt => ['launching','running'].includes(attempt.status))
    .map(attempt => ({ kind: 'admin-cli', pid: attempt.pid || 0 }));
  return {
    ...business,
    async activateExternalRuntimeUpdate(authority: RuntimeUpdateAuthority) {
      const pending = store.assertRuntimeUpdate(authority);
      const artifact = runtimeActivationTarget(pending);
      if (!artifact || resolve(artifact.root) !== appRoot) throw new Error('外部更新激活不能作用于其他阶段或安装目录');
      const actualVersion = JSON.parse(readFileSync(join(appRoot,'package.json'),'utf8')).version;
      if (actualVersion !== artifact.version) throw new Error('实际安装版本与待激活产物不一致');
      // Clear the business update state while management silence still fences
      // all dispatch. Only the external healthy terminal transaction releases
      // that second barrier; ordinary resume commands cannot call this path.
      const receipt = await business.command({ requestId: `external-activation:${authority.updateId}:${artifact.artifactId}`,
        source: { adapter: options.adapter, instanceId: options.ownerId, actor: 'host' }, action: { kind: 'resume-after-update' } });
      const current = store.assertRuntimeUpdate(authority);
      if (current.phase !== pending.phase) throw new Error('外部激活期间更新阶段已经变化');
      return receipt;
    },
    async start() {
      await host.initialize();
      if(process.env.LOOP_RUNTIME_SAFETY==='standard')void management.reconcile().catch(log);
      else await management.reconcile();
      await host.reconcileIdleSleep();
    },
    async command(command: LifecycleCommand): Promise<LifecycleReceipt> {
      if (command.action.kind === 'resume-after-update' && store.activeRuntimeUpdate()) {
        return { requestId: command.requestId, outcome: 'update-in-progress', snapshot: await business.status() };
      }
      if (command.action.kind === 'start' || command.action.kind === 'stop') {
        if (command.action.kind === 'start' && store.control().management_mode !== 'normal') {
          return { requestId: command.requestId, outcome: 'update-in-progress', snapshot: await business.status() };
        }
        await host.setIntent(command.action.kind === 'start' ? 'running' : 'stopped', command.requestId);
        const remaining = residual();
        if (remaining.length && command.action.kind === 'stop') {
          return { requestId: command.requestId, outcome: 'blocked', error: 'Admin 实际退出尚未确认',
            residualProcesses: remaining, snapshot: await business.status() };
        }
        return { ...(lastReceipt || { outcome: 'failed', error: '业务宿主尚不可用', snapshot: await business.status() }), requestId: command.requestId };
      }
      if (command.action.kind === 'prepare-update') {
        // prepareUpdate persists silence synchronously before awaiting cleanup.
        const preparing = management.prepareUpdate(command.requestId);
        await Promise.all([preparing, host.reconcileIdleSleep()]);
        const remaining = residual();
        if (remaining.length) return { requestId: command.requestId, outcome: 'blocked', error: '更新前 Admin 实际退出尚未确认',
          residualProcesses: remaining, snapshot: await business.status() };
      }
      const receipt = await business.command(command);
      if (command.action.kind === 'resume-after-update') {
        store.setUpdateSilence(false, command.requestId);
        await management.reconcile();
        await host.reconcileIdleSleep();
      }
      return receipt;
    },
    async verifyUpdateReadiness(): Promise<LifecycleReceipt> {
      const remaining = residual();
      if (remaining.length) return { outcome: 'blocked', error: 'Admin 实际退出尚未确认', residualProcesses: remaining, snapshot: await business.status() };
      return business.verifyUpdateReadiness();
    },
    shutdown(_preserveIntent = true) {
      if (!shutdown) shutdown = host.shutdown().finally(() => { if (!options.management?.store) store.close(); });
      return shutdown;
    },
  };
}
