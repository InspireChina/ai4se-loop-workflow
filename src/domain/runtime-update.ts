import { z } from 'zod';
import { isAbsolute } from 'node:path';

export const runtimeArtifactSchema = z.object({
  root: z.string().min(1).max(4000).refine(path => isAbsolute(path) && !/[\x00-\x1f]/.test(path)),
  sourceId: z.string().regex(/^[a-f0-9]{64}$/),
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().min(1).max(200),
}).strict();
export type RuntimeArtifact = z.infer<typeof runtimeArtifactSchema>;
export const runtimeUpdatePhaseSchema = z.enum([
  'stopping', 'candidate-starting', 'candidate-activating', 'candidate-observing',
  'rolling-back', 'known-good-starting', 'known-good-activating', 'known-good-observing',
  'succeeded', 'rolled-back', 'aborted',
]);
export type RuntimeUpdatePhase = z.infer<typeof runtimeUpdatePhaseSchema>;
// New durable requests and the native host share admission syntax. History
// decoding remains broader so old rejected requests stay diagnosable.
export const runtimeUpdateIdSchema=z.string().regex(/^[A-Za-z0-9-]{1,200}$/);
export const runtimeUpdateRequestSchema = z.object({
  updateId: z.string().trim().min(1).max(200),
  caseId: z.string().trim().min(1).max(200),
  before: runtimeArtifactSchema,
  candidate: runtimeArtifactSchema,
}).strict().refine(value => value.before.root !== value.candidate.root && value.before.artifactId !== value.candidate.artifactId,
  '候选与原安装必须使用不同的不可变产物目录和身份');
export type RuntimeUpdateRequest = z.infer<typeof runtimeUpdateRequestSchema>;
export type RuntimeUpdateAuthority = { updateId: string; ownerId: string; token: number };
/** A snapshot became stale, not proof of a schema/data incompatibility.
 * Keep the phase guarded and acquire a fresh snapshot on the next reconcile. */
export class RuntimeCompatibilityResample extends Error {
  constructor(message: string) { super(message); this.name = 'RuntimeCompatibilityResample'; }
}
export type RuntimeHostAuthority = {ownerId:string;token:number};
export type RuntimeInstallation = {artifact:RuntimeArtifact;revision:number;updateId:string|null};
export const publisherUpdateSchema = z.object({
  requestId:z.string().trim().min(1).max(200),attemptId:z.string().trim().min(1).max(200),
  targetVersion:z.string().trim().min(1).max(200),before:runtimeArtifactSchema,
  intentRevision:z.number().int().nonnegative(),
  status:z.enum(['preparing','ready','transitioned','aborted']),
}).strict();
export type PublisherUpdate=z.infer<typeof publisherUpdateSchema>;
export type RuntimeHostProcess = {
  allocationId:string;authority:RuntimeHostAuthority;artifact:RuntimeArtifact;
  status:'reserved'|'bound'|'ready'|'exited';
  pid:number|null;marker:string|null;groupId:number|null;parentPid:number;
  businessSupervisionToken?:number|null;
};
/** UI lifetime is independent of business run/CLI allocations. */
export type RuntimeUiProcess = Omit<RuntimeHostProcess,'businessSupervisionToken'>;
export type RuntimeUpdateRecord = {
  request: RuntimeUpdateRequest; phase: RuntimeUpdatePhase;
  /** Historical startup receipt; the original installation stays immutable. */
  rollback?: { artifact: RuntimeArtifact; sourceUpdateId: string };
  selected: RuntimeArtifact; intentRevision: number;
  ownerId: string | null; token: number; expiresAt: number;
  failure: string | null; createdAt: number; updatedAt: number;
};
export const runtimeRollbackTarget = (update: RuntimeUpdateRecord) => update.rollback?.artifact || update.request.before;
export const runtimeActivationTarget = (update: RuntimeUpdateRecord) => update.phase === 'candidate-activating'
  ? update.request.candidate : update.phase === 'known-good-activating' ? runtimeRollbackTarget(update) : null;
export type RuntimeUpdateProcess = {
  allocationId: string; authority: RuntimeUpdateAuthority; artifact: RuntimeArtifact;
  status: 'reserved' | 'bound' | 'ready' | 'activated' | 'exited';
  pid: number | null; marker: string | null; groupId: number | null; parentPid: number;
};
export const runtimeUpdateTerminal = (phase: RuntimeUpdatePhase) => ['succeeded','rolled-back','aborted'].includes(phase);
export const runtimeUpdateTransitions: Record<RuntimeUpdatePhase, readonly RuntimeUpdatePhase[]> = {
  stopping: ['candidate-starting','rolling-back','aborted'],
  'candidate-starting': ['candidate-activating','rolling-back','aborted'],
  'candidate-activating': ['candidate-observing','rolling-back','aborted'],
  'candidate-observing': ['succeeded','rolling-back','aborted'],
  'rolling-back': ['known-good-starting','aborted'],
  'known-good-starting': ['known-good-activating','rolling-back','aborted'],
  'known-good-activating': ['known-good-observing','rolling-back','aborted'],
  'known-good-observing': ['rolled-back','rolling-back','aborted'],
  succeeded: [], 'rolled-back': [], aborted: [],
};
