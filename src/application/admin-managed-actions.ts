import type { AdminAuthority } from '../domain/repair-case';
import type { AdminManagementStore } from '../infrastructure/admin-management-store';
import { acquireRepairTakeover, repairTakeoverAuthorization } from './repair-takeover';
import type { RepairResourceOwner } from './repair-resources';

/** Business-capability adapter, injected into Controller. The independent
 * command entry and management core never import business storage. */
export function createAdminManagedActions(ports: {
  store: AdminManagementStore;
  takeover: (input: Parameters<typeof acquireRepairTakeover>[0]['target'], assertCurrent: Parameters<typeof acquireRepairTakeover>[0]['assertCurrent'], previousOwnerStopped: (owner: RepairResourceOwner) => boolean) => ReturnType<typeof acquireRepairTakeover>;
}) {
  return async (authority: AdminAuthority) => {
    for (const request of ports.store.pendingCommandActions(authority)) {
      const { claim, action } = request;
      if(action.kind!=='workspace-takeover')continue; // Harness source is independent of business storage.
      const source = ports.store.observations(claim.repairCase.caseId).map(raw => {
        const observation = raw as { origin: string; evidence_json: string };
        return { ...JSON.parse(observation.evidence_json) as { taskId?: string; item?: { item_id?: string; revision?: number } }, origin: observation.origin };
      }).find(evidence => evidence.origin === 'business' && evidence.item?.item_id === action.itemId);
      try {
        if (!source?.taskId) throw new Error('接管动作缺少当前 Case 的可信需求来源');
        const target = { caseId: claim.repairCase.caseId, generation: claim.attempt.generation,
          ownerId: claim.authority.ownerId, supervisionToken: claim.authority.token, taskId: source.taskId,
          itemId: action.itemId, itemRevision: action.itemRevision, reason: action.reason };
        const result = await ports.takeover(target, repairTakeoverAuthorization(claim, current => ports.store.readCommandSubmission(current)), owner =>
          ports.store.attempts(owner.case_id).some(attempt => attempt.generation === owner.generation
            && attempt.ownerId === owner.owner_id && attempt.supervisionToken === owner.supervision_token
            && !['launching','running'].includes(attempt.status)));
        ports.store.recordCommandActionResult(claim, request.key, result.phase === 'owned' ? 'completed' : 'pending', result);
      } catch (error) {
        ports.store.recordCommandActionResult(claim, request.key, 'failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
}
