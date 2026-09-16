export type RepairScope = 'execution' | 'work-item' | 'run' | 'runtime';
export type RepairCaseStatus = 'queued' | 'running' | 'verifying' | 'observing' | 'external-wait' | 'closed';

export type RepairObservation = {
  observationId: string;
  scope: RepairScope;
  scopeKey: string;
  fingerprint: string;
  sourceVersion: string;
  summary: string;
  evidence: Record<string, unknown>;
  origin: 'business' | 'runtime' | 'admin';
  repairCaseId?: string;
};

export type AdminAuthority = { ownerId: string; token: number };
export type RepairCase = {
  caseId: string;
  scope: RepairScope;
  scopeKey: string;
  fingerprint: string;
  originalVersion: string;
  originalSummary: string;
  status: RepairCaseStatus;
  generation: number;
  currentAttemptId: string | null;
  nextProbeAt: number | null;
  lastError: string | null;
};
export type RepairAttempt = {
  role: 'investigation' | 'verification';
  attemptId: string;
  caseId: string;
  ownerId: string;
  supervisionToken: number;
  generation: number;
  intentRevision: number;
  status: 'launching' | 'running' | 'completed' | 'failed' | 'interrupted';
  pid: number | null;
  startMarker: string | null;
  processGroupId: number | null;
  lastError: string | null;
};
export type RepairClaim = { authority: AdminAuthority; repairCase: RepairCase; attempt: RepairAttempt };
