import type { AdminManagementStore } from '../infrastructure/admin-management-store';
import type { createAdminController } from './admin-controller';

type Intent = { desired: 'running' | 'stopped'; revision: number };
type Management = Pick<ReturnType<typeof createAdminController>, 'start' | 'stop' | 'reconcile' | 'shutdown'>;

/** Shared desktop/standalone bootstrap protocol. Management storage owns the
 * run intent; reading a stale business DB must never restart stopped repair.
 * Business adapters must persist the supplied intent BEFORE starting their
 * supervision timers or invoking a Runner. */
export function createRuntimeSupervisionHost(ports: {
  store: AdminManagementStore;
  management: Management;
  idleSleep?: { start: () => Promise<void>; reconcile: () => Promise<void>; shutdown: () => Promise<void> };
  business: {
    initialize: (intent: Intent) => Promise<void>;
    applyIntent: (intent: Intent) => Promise<void>;
    shutdown: () => Promise<void>;
  };
  reportBusinessFailure: (error: unknown, phase: 'initialize' | 'intent' | 'shutdown') => void;
  scheduleInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
  cancelInterval?: (timer: NodeJS.Timeout) => void;
}) {
  let initializing: Promise<void> | undefined;
  let businessInitialized = false;
  let closed = false;
  let shutdown: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let healthPending = false;
  let businessOperation = Promise.resolve();
  const intent = (): Intent => {
    const control = ports.store.control();
    return { desired: control.desired_intent, revision: control.intent_revision };
  };
  const report = (error: unknown, phase: 'initialize' | 'intent' | 'shutdown') => {
    // A broken diagnostic sink cannot kill independent supervision.
    try { ports.reportBusinessFailure(error, phase); } catch { /* management remains live */ }
  };
  const serializeBusiness = (work: () => Promise<void>) => {
    const next = businessOperation.catch(() => undefined).then(work);
    businessOperation = next;
    return next;
  };

  async function synchronizeBusiness() {
    if (closed) return;
    try {
      if (!businessInitialized) {
        await ports.business.initialize(intent());
        businessInitialized = true;
      }
      if (closed) return;
      // User stop may have arrived while initialization was blocked. Read
      // again rather than replaying the pre-initialization snapshot.
      let applied: Intent;
      do {
        applied = intent();
        await ports.business.applyIntent(applied);
      } while (!closed && intent().revision !== applied.revision);
    } catch (error) { report(error, businessInitialized ? 'intent' : 'initialize'); }
  }

  return {
    initialize() {
      if (closed) return Promise.reject(new Error('已关闭的监督宿主不能重新初始化'));
      if (!initializing) {
        initializing = (async () => {
          // Its timers/lease are installed before any business DB access.
          const management = ports.management.start();
          // Independent polling of management intent/lease must not wait for
          // a hung business DB or a slow management process cleanup.
          const idleSleep = ports.idleSleep?.start();
          if (!timer) {
            timer = (ports.scheduleInterval || setInterval)(() => {
              if (closed || healthPending) return;
              healthPending = true;
              void serializeBusiness(synchronizeBusiness).finally(() => { healthPending = false; });
            }, 10_000);
            timer.unref();
          }
          await Promise.all([management.then(() => ports.idleSleep?.reconcile()), idleSleep, serializeBusiness(synchronizeBusiness)]);
        })().catch(error => { initializing = undefined; throw error; });
      }
      return initializing;
    },
    async setIntent(desired: Intent['desired'], requestId: string) {
      if (closed) throw new Error('已关闭的监督宿主不能修改运行意图');
      const revision = ports.store.setIntent(desired, requestId);
      const current = intent();
      // Replaying an old start command after a newer stop must be a no-op.
      if (revision !== current.revision) return revision;
      const management = desired === 'stopped'
        ? ports.management.stop(requestId)
        : ports.management.reconcile();
      // Do not put physical cancellation behind an unavailable business DB,
      // nor business cancellation behind slow management process cleanup.
      await Promise.all([management, ports.idleSleep?.reconcile(), serializeBusiness(synchronizeBusiness)]);
      return revision;
    },
    /** Host health tick can retry unavailable business initialization without
     * creating another management Controller or changing durable intent. */
    reconcileBusiness: () => serializeBusiness(synchronizeBusiness),
    reconcileIdleSleep: () => ports.idleSleep?.reconcile() || Promise.resolve(),
    shutdown() {
      if (shutdown) return shutdown;
      closed = true;
      if (timer) (ports.cancelInterval || clearInterval)(timer);
      timer = undefined;
      // Host shutdown preserves durable user intent, unlike user stop.
      shutdown = Promise.allSettled([
        ports.idleSleep?.shutdown(),
        ports.management.shutdown(),
        serializeBusiness(async () => {
          if (!businessInitialized) return;
          try { await ports.business.shutdown(); } catch (error) { report(error, 'shutdown'); }
        }),
      ]).then(results => {
        // One failed OS release must not close management storage while the
        // independent physical process cleanup is still running.
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, '监督宿主退出尚未全部完成');
      });
      return shutdown;
    },
  };
}
