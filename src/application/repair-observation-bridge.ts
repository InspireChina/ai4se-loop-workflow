import type { RepairCase, RepairObservation } from '../domain/repair-case';

/** Management orchestration depends on ports, not a readable business DB. */
export function createRepairObservationBridge(ports: {
  pending: () => Promise<RepairObservation[]>;
  observe: (observation: RepairObservation) => RepairCase;
  acknowledge: (observationId: string, caseId: string) => Promise<unknown>;
}) {
  return async () => {
    let delivered = 0;
    for (const observation of await ports.pending()) {
      const repairCase = ports.observe(observation);
      await ports.acknowledge(observation.observationId, repairCase.caseId);
      delivered++;
    }
    return delivered;
  };
}
