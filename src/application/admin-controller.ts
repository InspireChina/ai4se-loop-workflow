import type { AdminAuthority, RepairAttempt, RepairClaim } from '../domain/repair-case';
import type { AdminManagementStore } from '../infrastructure/admin-management-store';

export type AdminExecutionCompletion = {
  outcome: 'failed' | 'verification-requested' | 'diagnosis-requested' | 'external-wait-requested' | 'verification-prepared' | 'verified'; reason: string; exitConfirmed: boolean; retryAt?: number;
};
export type AdminExecutionHandle = {
  completion: Promise<AdminExecutionCompletion>;
  stop: () => Promise<boolean>;
};
export type AdminControllerPorts = {
  store: AdminManagementStore;
  ownerId: string;
  launch: (claim: RepairClaim, bindProcess: (pid: number, marker?: string, groupId?: number) => void, signal: AbortSignal) => Promise<AdminExecutionHandle>;
  launchVerification?: AdminControllerPorts['launch'];
  confirmStopped: (attempt: RepairAttempt) => Promise<boolean>;
  discover?: () => Promise<unknown>;
  reconcileTakeovers?: (authority: AdminAuthority) => Promise<{ attemptIds: string[]; revoked?: number; draining?: number }>;
  manageActions?: (authority: AdminAuthority) => Promise<unknown>;
  manageFollowups?: (authority: AdminAuthority) => Promise<unknown>;
  /** Cancel capability children without waiting behind discovery/business DB work. */
  stopCapabilities?: () => Promise<void>;
  /** Update silence drains writers but permits Root-owned, read-only update
   * evidence. User STOP/fencing/shutdown still calls stopCapabilities. */
  suspendCapabilities?: () => Promise<void>;
  /** Before ordinary business admission, drain predecessor capability writers. */
  prepareCapabilities?: () => Promise<void>;
  onError?: (error: unknown) => void;
  scheduleInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
  cancelInterval?: (timer: NodeJS.Timeout) => void;
};

/** Independent management scheduling. No business ready queue or normal Agent slots. */
export function createAdminController(ports: AdminControllerPorts) {
  const { store } = ports;
  let authority: AdminAuthority | null = null;
  let timer: NodeJS.Timeout | undefined;
  let pendingTick = false;
  let shuttingDown = false;
  let operation = Promise.resolve<unknown>(undefined);
  const active = new Map<string, { claim: RepairClaim; handle: AdminExecutionHandle; completionSettled: boolean }>();
  const launchControllers = new Map<string, AbortController>();
  const settlements = new Set<Promise<void>>();
  let capabilityStop: Promise<void> | undefined;
  const report = (error: unknown) => {
    try { ports.onError?.(error); } catch { /* Diagnostics cannot stop supervision or physical cleanup. */ }
  };
  const serialize = <T>(work: () => Promise<T>) => {
    const next = operation.catch(() => undefined).then(work);
    operation = next;
    return next;
  };
  const stopExecutionAndCapabilities = async () => {
    const capabilities = capabilityStop ??= Promise.resolve().then(() => ports.stopCapabilities?.())
      .finally(() => { capabilityStop = undefined; });
    const results = await Promise.allSettled([stopActive(), capabilities]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '管理能力实际退出未确认');
  };
  const inactiveState = () => {
    if (shuttingDown) return 'stopped' as const;
    if (authority && store.isAuthorityCurrent(authority)) return null;
    const control = store.control();
    return control.desired_intent !== 'running' || control.management_mode !== 'normal'
      ? 'stopped' as const : 'observer' as const;
  };

  async function settle(claim: RepairClaim, result: AdminExecutionCompletion) {
    try {
      if (claim.attempt.role === 'verification' && store.verificationReceipt(claim.attempt.attemptId)) {
        if (!store.finishVerification(claim, result.exitConfirmed) && result.exitConfirmed) {
          store.finishAttempt(claim, { ...result, outcome: 'failed', reason: '独立验证来源已失效，保留收据并重新调查' });
        }
      } else if (result.outcome === 'verification-prepared') {
        if (!store.finishVerificationPreparation(claim, result.exitConfirmed) && result.exitConfirmed) {
          store.finishAttempt(claim, { ...result, outcome: 'failed', reason: '独立验收准备缺少有效持久化来源，重新调查' });
        }
      } else {
        if (result.outcome === 'verified') throw new Error('验证执行没有持久化的独立验证收据，不能标记通过');
        store.finishAttempt(claim, result);
      }
    } catch (error) {
      // A late completion cannot mutate a newer generation. Its physical exit
      // can be reconciled by the current owner, including after a user stop.
      if (authority) {
        try { store.retireStoppedAttempt(authority, claim.attempt.attemptId, result.exitConfirmed, result.reason); }
        catch { report(error); }
      }
    } finally {
      if (result.exitConfirmed) active.delete(claim.attempt.attemptId);
      else {
        const entry = active.get(claim.attempt.attemptId);
        if (entry) entry.completionSettled = true;
      }
    }
  }

  async function stopActive() {
    for (const controller of launchControllers.values()) controller.abort();
    for (const { claim, handle } of [...active.values()]) {
      try {
        const confirmed = await handle.stop();
        if (confirmed && authority) {
          store.retireStoppedAttempt(authority, claim.attempt.attemptId, true, '管理运行停止或监督权切换');
          active.delete(claim.attempt.attemptId);
        }
      } catch (error) { report(error); }
    }
  }

  async function stopDurableAttempts() {
    // A UI host may be an observer while the desktop host owns supervision.
    // User stop/update still cancels known physical processes immediately;
    // retiring their records remains fenced to the current supervisor.
    for (const attempt of store.attempts().filter(row => ['launching', 'running'].includes(row.status))) {
      if (active.has(attempt.attemptId)) continue;
      try {
        const stopped = await ports.confirmStopped(attempt);
        if (authority) store.retireStoppedAttempt(authority, attempt.attemptId, stopped, '跨宿主停止管理执行');
      } catch (error) { report(error); }
    }
  }

  async function reconcileInvalidTakeovers(current: AdminAuthority) {
    if (!ports.reconcileTakeovers) return;
    const first = await ports.reconcileTakeovers(current);
    let stoppedAny = false;
    for (const attemptId of [...new Set(first.attemptIds)]) {
      const entry = active.get(attemptId);
      if (entry) {
        const stopped = await entry.handle.stop();
        if (!stopped) continue;
        store.retireStoppedAttempt(current, attemptId, true, '修复接管来源失效，撤销执行权限');
        active.delete(attemptId); stoppedAny = true; continue;
      }
      const attempt = store.attempts().find(row => row.attemptId === attemptId);
      if (!attempt) continue;
      const stopped = await ports.confirmStopped(attempt);
      if (!stopped) continue;
      store.retireStoppedAttempt(current, attemptId, true, '修复接管来源失效，跨宿主撤销执行权限');
      stoppedAny = true;
    }
    // The trusted business capability may release the fence only after the
    // management attempt above is durably terminal.
    if (stoppedAny) await ports.reconcileTakeovers(current);
  }

  async function reconcileOwned() {
    if (shuttingDown) return 'stopped' as const;
    authority = store.acquireSupervisor(ports.ownerId);
    if (!authority) {
      await stopExecutionAndCapabilities();
      return 'observer' as const;
    }
    const control = store.control();
    if (control.desired_intent !== 'running' || control.management_mode !== 'normal') {
      if(control.desired_intent==='running'&&control.management_mode==='update-silence'&&ports.suspendCapabilities){
        const results=await Promise.allSettled([stopActive(),Promise.resolve().then(()=>ports.suspendCapabilities!())]);
        const failed=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
        if(failed)throw failed.reason;
      }else await stopExecutionAndCapabilities();
      for (const attempt of store.attempts().filter(row => ['launching', 'running'].includes(row.status))) {
        if (active.has(attempt.attemptId)) continue;
        try {
          const stopped = await ports.confirmStopped(attempt);
          store.retireStoppedAttempt(authority, attempt.attemptId, stopped, '用户停止后的管理执行清理');
        } catch (error) { report(error); }
      }
      return 'stopped' as const;
    }
    // Discovery is an adapter, not a dependency on healthy business storage.
    // Already durable management work continues even if this read fails.
    try { await ports.discover?.(); } catch (error) { report(error); }
    const afterDiscovery = inactiveState();
    if (afterDiscovery) return afterDiscovery;
    try { await reconcileInvalidTakeovers(authority); } catch (error) { report(error); }
    const afterRevocation = inactiveState();
    if (afterRevocation) return afterRevocation;
    try { await ports.manageActions?.(authority); } catch (error) { report(error); }
    for (const entry of [...active.values()]) {
      if (!entry.completionSettled) continue;
      try {
        const stopped = await entry.handle.stop();
        if (stopped) {
          if (!store.recoverStoppedSubmission(authority, entry.claim.attempt.attemptId, true)) {
            store.retireStoppedAttempt(authority, entry.claim.attempt.attemptId, true, '不确定退出后的实际清理已确认');
          }
          active.delete(entry.claim.attempt.attemptId);
        }
      } catch (error) { report(error); }
    }
    for (const attempt of store.attempts().filter(row => ['launching', 'running'].includes(row.status))) {
      if (active.has(attempt.attemptId)) continue;
      try {
        const stopped = await ports.confirmStopped(attempt);
        if (!store.recoverStoppedSubmission(authority, attempt.attemptId, stopped)) {
          store.retireStoppedAttempt(authority, attempt.attemptId, stopped, '恢复失联 Admin；保留原调查记录');
        }
      } catch (error) { report(error); }
    }
    try { await ports.manageFollowups?.(authority); } catch (error) { report(error); }
    const afterCleanup = inactiveState();
    if (afterCleanup) return afterCleanup;
    if (active.size) return 'running' as const;
    // Re-check intent and authority atomically in claimNext, after slow cleanup.
    let claim: RepairClaim | null;
    try { claim = store.claimScheduled(authority, Boolean(ports.launchVerification)); }
    catch (error) {
      // A stop/update/fence can commit from another host between our read and
      // the atomic claim. It is cancellation, not a failed repair attempt.
      const inactive = inactiveState();
      if (inactive) return inactive;
      report(error);
      return 'blocked' as const;
    }
    if (!claim) return 'idle' as const;
    const cancellation = new AbortController();
    launchControllers.set(claim.attempt.attemptId, cancellation);
    try {
      const launcher = claim.attempt.role === 'verification' ? ports.launchVerification! : ports.launch;
      const handle = await launcher(claim, (pid, marker, groupId) => store.attachProcess(claim, pid, marker, groupId), cancellation.signal);
      active.set(claim.attempt.attemptId, { claim, handle, completionSettled: false });
      const latest = store.control();
      if (cancellation.signal.aborted || !store.isAuthorityCurrent(claim.authority) || latest.intent_revision !== claim.attempt.intentRevision
        || latest.owner_id !== claim.authority.ownerId || latest.fencing_token !== claim.authority.token) {
        await stopActive();
      }
      const completion = handle.completion.catch((error): AdminExecutionCompletion => ({
        outcome: 'failed', reason: error instanceof Error ? error.message : String(error), exitConfirmed: false,
      })).then(result => settle(claim, result));
      settlements.add(completion);
      void completion.finally(() => { settlements.delete(completion); }).catch(report);
      return 'launched' as const;
    } catch (error) {
      // Launch rejection does not prove that no child was spawned. Preserve
      // its allocation until the physical adapter confirms it stopped.
      const reason = error instanceof Error ? error.message : String(error);
      try { store.finishAttempt(claim, { outcome: 'failed', exitConfirmed: false, reason }); }
      catch { report(error); }
      report(error);
      return 'blocked' as const;
    } finally {
      launchControllers.delete(claim.attempt.attemptId);
    }
  }

  return {
    reconcile: () => serialize(reconcileOwned),
    async start() {
      if (shuttingDown) throw new Error('已关闭的 Admin Controller 不能重新启动');
      if (!timer) {
        timer = (ports.scheduleInterval || setInterval)(() => {
          // Renewal is never queued behind slow launch/cleanup.
          try {
            if (authority && !store.renewSupervisor(authority)) void stopExecutionAndCapabilities().catch(report);
          } catch (error) { report(error); void stopExecutionAndCapabilities().catch(report); }
          if (pendingTick) return;
          pendingTick = true;
          void serialize(reconcileOwned).catch(report).finally(() => { pendingTick = false; });
        }, 10_000);
        timer.unref();
      }
      return serialize(reconcileOwned);
    },
    async stop(requestId: string) {
      store.setIntent('stopped', requestId);
      // Cancellation is not queued behind slow launch or orphan inspection.
      const results = await Promise.allSettled([stopExecutionAndCapabilities(), stopDurableAttempts()]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
      return serialize(reconcileOwned);
    },
    async prepareUpdate(requestId: string) {
      store.setUpdateSilence(true, requestId);
      const results = await Promise.allSettled([stopExecutionAndCapabilities(), stopDurableAttempts()]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
      return serialize(reconcileOwned);
    },
    async shutdown() {
      shuttingDown = true;
      if (timer) (ports.cancelInterval || clearInterval)(timer);
      timer = undefined;
      // Stop both paths even if a capability fails. Never relinquish the
      // management lease while its physical exit is still uncertain.
      await Promise.allSettled([stopExecutionAndCapabilities()]);
      await serialize(async () => {
        const retryResult = await Promise.allSettled([stopExecutionAndCapabilities()]);
        // A failed launcher can leave an owned durable allocation outside
        // active. Host shutdown must not clear supervision while that CLI's
        // actual exit remains unknown. Retry shutdown can confirm it later.
        for(const attempt of store.attempts().filter(row=>row.ownerId===ports.ownerId&&['launching','running'].includes(row.status))){
          if(active.has(attempt.attemptId))continue;
          try{
            const stopped=await ports.confirmStopped(attempt);
            if(authority)store.retireStoppedAttempt(authority,attempt.attemptId,stopped,'关闭独立管理宿主，核对实际退出');
          }catch(error){report(error);}
        }
        if(active.size||store.attempts().some(row=>row.ownerId===ports.ownerId&&['launching','running'].includes(row.status)))
          throw new Error('Admin 实际进程退出未确认，保留管理宿主所有权');
        const failed = retryResult.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if(failed)throw failed.reason;
        if (authority) store.releaseSupervisor(authority);
        authority = null;
      });
    },
    waitForSettlements: () => Promise.all([...settlements]),
  };
}
