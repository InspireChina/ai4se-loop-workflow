import {z} from 'zod';
import {runtimeHostHealthSchema} from './runtime-host-health';
const pid=z.number().int().positive();
// Observed database facts, not a claim of current process liveness or ownership.
export const businessLifecycleObservationSchema=z.object({
  desired:z.enum(['running','stopped']),revision:z.number().int().nonnegative(),
  mode:z.enum(['normal','update-silence']),
  phase:z.enum(['starting','running','stopping','stopped','crashed']),
  runId:z.string().nullable(),restartCount:z.number().int().nonnegative(),retryAt:z.string().nullable(),
  lastError:z.string().nullable(),updateAttemptId:z.string().nullable(),targetVersion:z.string().nullable(),readiness:z.string().nullable(),
  lease:z.object({ownerId:z.string(),token:pid,expiresAt:z.string()}).strict().nullable(),
  run:z.object({status:z.string(),startedAt:z.string().nullable(),heartbeatAt:z.string().nullable()}).strict().nullable(),
}).strict();
export const runtimeHostAuditSchema=z.object({
  databasePresent:z.boolean(),knownProtocol:z.boolean(),
  managed:z.array(z.object({id:z.string(),kind:z.enum(['ui-server','agent-runner','agent-cli']),pid,marker:z.string().min(1),supervisionToken:pid}).strict()).max(5000),
  executions:z.array(z.object({id:z.string(),pid:pid.nullable(),marker:z.string().nullable(),groupId:pid.nullable()}).strict()).max(5000),
  runs:z.array(z.object({id:z.string(),pid:pid.nullable(),supervisionToken:pid.nullable()}).strict()).max(5000),
  legacyHealth:runtimeHostHealthSchema.optional(),
  lifecycle:businessLifecycleObservationSchema.optional(),
}).strict();
export type RuntimeHostAudit=z.infer<typeof runtimeHostAuditSchema>;
