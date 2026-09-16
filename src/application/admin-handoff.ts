import type { AdminAuthority } from '../domain/repair-case';
import type { AdminManagementStore } from '../infrastructure/admin-management-store';
import type { RepairHandoffReceipt, RepairHandoffTarget } from './repair-handoff';
import type { RepairBusinessProgress, RepairBusinessReadiness } from '../domain/repair-followup';
import type { RepairObservation } from '../domain/repair-case';
import { RepairHandoffVersionChanged } from '../domain/repair-followup';
import { OriginalCoverageMissing } from '../domain/original-coverage';

/** Route verified management facts to a trusted business capability. No Agent
 * command exposes this operation or carries arbitrary workflow completion. */
export async function handoffAdminRepair(ports: {
  store: AdminManagementStore; authority: AdminAuthority; caseId: string;
  handoff: (target: RepairHandoffTarget, assertCurrent: () => void) => Promise<RepairHandoffReceipt>;
}) {
  const context = ports.store.verifiedContext(ports.authority, ports.caseId);
  const observations = ports.store.observations(ports.caseId).map(raw => {
    const row = raw as { observation_id: string; origin: string; evidence_json: string };
    return { id: row.observation_id, origin: row.origin, evidence: JSON.parse(row.evidence_json) as
      { taskId?: string; item?: { item_id?: string; revision?: number; dispatch_epoch?: number } } };
  }).filter(row => row.origin === 'business' && context.receipt.plan.originalObservationIds.includes(row.id));
  const anchor = ports.store.repairWorkspaceAnchor(context.repair.attemptId);
  if (!observations.length) {
    throw new Error('交还缺少已验证的可信业务工作项来源');
  }
  const lineage = [{ itemId: anchor.itemId, revision: anchor.itemRevision }, ...(anchor.predecessors || [])];
  if (observations.some(row => row.evidence.taskId !== anchor.taskId || !row.evidence.item?.item_id
    || !lineage.some(item => item.itemId === row.evidence.item!.item_id))) {
    throw new Error('交还不能合并不同业务工作项或来源版本');
  }
  const target: RepairHandoffTarget = { caseId: context.repairCase.caseId, verificationAttemptId: context.verification.attemptId,
    repairGeneration: context.repair.generation, repairOwnerId: context.repair.ownerId, repairSupervisionToken: context.repair.supervisionToken,
    taskId: anchor.taskId, itemId: anchor.itemId, itemRevision: anchor.itemRevision, itemEpoch: anchor.itemEpoch,
    expectedVersion: context.receipt.plan.expectedVersion, reason: '独立验证确认修复，交回正常工作项继续；原始失败和验收记录保留' };
  const assertCurrent = () => {
    const current = ports.store.verifiedContext(ports.authority, ports.caseId);
    if (current.verification.attemptId !== target.verificationAttemptId || current.repair.attemptId !== context.repair.attemptId) {
      throw new Error('修复交还的验证代次已改变');
    }
  };
  const receipt = await ports.handoff(target, assertCurrent);
  assertCurrent();
  ports.store.recordHandoffReceipt(ports.authority, ports.caseId, receipt);
  return receipt;
}

export function createAdminHandoffs(ports: {
  store: AdminManagementStore;
  handoff: (target: RepairHandoffTarget, assertCurrent: () => void) => Promise<RepairHandoffReceipt>;
  observeProgress?: (receipt: RepairHandoffReceipt) => Promise<{ progress: RepairBusinessProgress | null; readCurrent: () => RepairBusinessProgress | null;
    readiness?: RepairBusinessReadiness }>;
  holdStalled?: (receipt: RepairHandoffReceipt, fingerprint: string, assertCurrent: () => void) => Promise<{
    observation: RepairObservation; acknowledge: () => Promise<unknown>;
  } | null>;
  onError?: (error: unknown) => void;
}) {
  return async (authority: AdminAuthority) => {
    for (const repairCase of ports.store.observingCases(authority)) {
      if (repairCase.scope !== 'work-item') continue; // Other scopes need their own trusted recovery capability.
      try {
        const receipt = await handoffAdminRepair({ ...ports, authority, caseId: repairCase.caseId });
        if (!ports.observeProgress) continue;
        const observation = await ports.observeProgress(receipt);
        if (!observation.progress) {
          if (observation.readiness && ports.store.sampleHandoffReadiness(authority, repairCase.caseId,
            receipt.target.verificationAttemptId, observation.readiness) && ports.holdStalled) {
            const assertCurrent = () => {
              ports.store.assertHandoffStallCurrent(authority, repairCase.caseId, receipt.target.verificationAttemptId);
            };
            const held = await ports.holdStalled(receipt, repairCase.fingerprint, assertCurrent);
            if (held) {
              assertCurrent();
              ports.store.recordHandoffStallObservation(authority, repairCase.caseId, receipt.target.verificationAttemptId, held.observation);
              ports.store.assertManagementAuthority(authority);
              await held.acknowledge();
            }
          }
          continue;
        }
        ports.store.recordBusinessProgress(authority, repairCase.caseId, observation.progress);
        ports.store.closeObservedCase(authority, repairCase.caseId, observation.readCurrent);
      }
      catch (error) {
        if (error instanceof OriginalCoverageMissing) {
          try { ports.store.recordIncompleteObservedCoverage(authority, repairCase.caseId); }
          catch (recordingError) { try { ports.onError?.(recordingError); } catch { /* diagnostics cannot block recovery */ } }
        }
        if (error instanceof RepairHandoffVersionChanged) {
          try {
            const context = ports.store.verifiedContext(authority, repairCase.caseId);
            ports.store.recordVerifiedVersionChange(authority, repairCase.caseId, { verificationAttemptId: context.verification.attemptId,
              expectedVersion: error.expectedVersion, actualVersion: error.actualVersion, workspaceRoot: error.workspaceRoot });
          } catch (recordingError) { try { ports.onError?.(recordingError); } catch { /* diagnostic callback cannot block recovery */ } }
        }
        try { ports.onError?.(error); } catch { /* preserve deterministic recovery even if diagnostics fail */ }
      }
    }
  };
}
