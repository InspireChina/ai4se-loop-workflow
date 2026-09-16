import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdminExecutionCompletion, AdminExecutionHandle } from '../application/admin-controller';
import { buildAdminPrompt } from '../application/admin-prompt';
import type { RepairAttempt, RepairClaim } from '../domain/repair-case';
import type { AgentExecutionOptions, AgentExecutor } from './agent-executor';
import { executeAgentInvocation } from './agent-invocation';
import type { AdminManagementStore } from './admin-management-store';
import { createAgentExecutionTempDirectory, removeAgentExecutionTempDirectory } from './agent-workspace-temp';
import type { resolveAgentExecutionLimits } from './agent-execution-limits';
import type { LangfuseTelemetry } from './langfuse';
import { sanitizeDiagnosticText } from './diagnostic-text';
import { inspectProcessGroup, terminateProcessGroup, terminateProcessTree, waitForProcessIdentity } from './process-tree';
import { createRepairActivityMonitor } from '../domain/repair-activity';
import { workspaceVersionCommand } from './repair-workspace-version';
import {confirmWindowsJobContainmentExit} from './windows-job-containment';

function safeActivityInput(value: unknown, token: string, depth = 0): unknown {
  if (depth > 20) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') return sanitizeDiagnosticText(value.replaceAll(token, '[REDACTED]'), 64_000);
  if (Array.isArray(value)) return value.map(child => safeActivityInput(child, token, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, /(?:api[_-]?key|token|secret|password|authorization|cookie)$/i.test(key)
      ? '[REDACTED]' : safeActivityInput(child, token, depth + 1)]));
  return value;
}

export function adminCommandLaunch(appRoot: string) {
  const bundled = join(appRoot, 'desktop-runners', 'loop-admin.cjs');
  return { command: process.env.LOOP_DESKTOP_NODE || process.execPath,
    args: existsSync(bundled) ? [bundled] : ['--import', pathToFileURL(join(appRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      join(appRoot, 'scripts', 'loop', 'loop-admin-entry.ts')] };
}

export function adminCommandReference(launch: ReturnType<typeof adminCommandLaunch>, platform: NodeJS.Platform = process.platform) {
  const quote = platform === 'win32'
    ? (value: string) => `'${value.replaceAll("'", "''")}'`
    : (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${platform === 'win32' ? '& ' : ''}${[launch.command, ...launch.args].map(quote).join(' ')}`;
}

export function adminBusinessEnvironmentBoundary(environment: Record<string, string | undefined> = process.env) {
  return Object.fromEntries(Object.keys(environment)
    .filter(key => /^LOOP_(?:EXECUTION|INTERNAL|INTERVENTION|VERIFICATION_ASSISTANCE)_/.test(key))
    .map(key => [key, undefined]));
}

export async function confirmAdminAttemptStopped(attempt: RepairAttempt,containment?:{dataRoot:string;allocationId?:string}) {
  if (!attempt.pid || !attempt.startMarker) return false;
  if(process.platform==='win32'&&containment)return confirmWindowsJobContainmentExit({dataRoot:containment.dataRoot,
    process:{allocationId:containment.allocationId??`admin-${attempt.attemptId}`,pid:attempt.pid,marker:attempt.startMarker}});
  if (attempt.processGroupId && process.platform !== 'win32') {
    return terminateProcessGroup(attempt.processGroupId, 5000, attempt.startMarker);
  }
  // An absent Windows root is not proof that its descendants stopped. A Job
  // Object / guardian adapter is still required for that lost-root boundary.
  const identity = await waitForProcessIdentity(attempt.pid, { timeoutMs: 1000 });
  if (!identity || identity.startMarker !== attempt.startMarker) return false;
  return terminateProcessTree(attempt.pid, 5000, attempt.startMarker);
}

export function createAdminExecutionLauncher(config: {
  store: AdminManagementStore; appRoot: string; dataRoot: string; workspaceRoot: string;
  /** Command/version tools belong to the stable management host, not the
   * selected business installation under investigation. */
  toolRoot?: string;
  executor: AgentExecutor; executionOptions: AgentExecutionOptions;
  limits: ReturnType<typeof resolveAgentExecutionLimits>; telemetry: LangfuseTelemetry;
  activityTimeoutMs?: number;
  activityPollIntervalMs?: number;
}) {
  return async (claim: RepairClaim, bind: (pid: number, marker?: string, groupId?: number) => void, signal: AbortSignal): Promise<AdminExecutionHandle> => {
    let preparedTemporary: ReturnType<typeof createAgentExecutionTempDirectory> | undefined;
    let removeAbortListener: (() => void) | undefined;
    try {
      const credential = config.store.issueCommandCredential(claim);
      const temporary = createAgentExecutionTempDirectory(config.workspaceRoot, claim.attempt.attemptId);
      preparedTemporary = temporary;
      const toolRoot = config.toolRoot ?? config.appRoot;
      const command = adminCommandLaunch(toolRoot);
      const monitor = createRepairActivityMonitor({ now: Date.now,
        timeoutMs: config.activityTimeoutMs ?? 20 * 60 * 1000, longToolTimeoutMs: 20 * 60 * 1000,
        known: operation => config.store.knownActivityCheckpoint(claim, operation),
        checkpoint: operation => config.store.recordActivityCheckpoint(claim, operation),
      });
      const prompt = buildAdminPrompt(config.store, claim, adminCommandReference(command), process.platform,
        workspaceVersionCommand(toolRoot, '<接管后的实际 workspaceRoot>'));
      const cancellation = new AbortController();
      const abort = () => cancellation.abort();
      signal.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
      let pid = 0;
      let marker: string | undefined;
      let groupId: number | undefined;
      let exitConfirmed = false;
      const containmentId=`admin-${claim.attempt.attemptId}`;
      const stopPhysical = async () => {
        if (!pid) return true; // pre-spawn cancellation is checked by invocation core
        if (groupId) {
          if (!marker) {
            const members = await inspectProcessGroup(groupId);
            return Boolean(members && members.length === 0);
          }
          return terminateProcessGroup(groupId, 5000, marker);
        }
        if(process.platform==='win32')return confirmWindowsJobContainmentExit({dataRoot:config.dataRoot,
          process:{allocationId:containmentId,pid,marker:marker??null}});
        if (!marker) return false;
        const identity = await waitForProcessIdentity(pid, { timeoutMs: 1000 });
        if (!identity || identity.startMarker !== marker) return false;
        return terminateProcessTree(pid, 5000, marker);
      };
      const logDirectory = join(config.dataRoot, 'admin', 'logs');
      await mkdir(logDirectory, { recursive: true });
      const log = (message: string) => {
        const safe = sanitizeDiagnosticText(message.replaceAll(credential.token, '[REDACTED]'));
        return appendFile(join(logDirectory, `${claim.attempt.attemptId}.log`), `${new Date().toISOString()} ${safe}\n`);
      };
      const invocation = executeAgentInvocation({
        runId: claim.repairCase.caseId, prompt, workspaceRoot: config.workspaceRoot,
        executor: config.executor, executionOptions: config.executionOptions,
        context: { agent: 'system-assistance-agent', taskId: claim.repairCase.scopeKey, storyIndex: null, pipeline: 'admin', lane: 'control' },
        description: `Admin investigation ${claim.attempt.generation}`, telemetry: config.telemetry,
        appendLog: log, ...config.limits, cancellationSignal: cancellation.signal,
        monitor: { ...monitor, intervalMs: config.activityPollIntervalMs ?? 1000,
          observe: event => monitor.observe({ ...event, input: safeActivityInput(event.input, credential.token) }) },
        isolateProcessGroup: process.platform !== 'win32',
        environment: {
          ...adminBusinessEnvironmentBoundary(),
          ...(process.env.LOOP_DESKTOP_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          LOOP_ADMIN_DB: config.store.filename, LOOP_ADMIN_CASE_ID: credential.caseId,
          LOOP_ADMIN_ATTEMPT_ID: credential.attemptId, LOOP_ADMIN_SESSION_ID: credential.sessionId, LOOP_ADMIN_COMMAND_TOKEN: credential.token,
          LOOP_AGENT_TMP_DIR: temporary.directory, LOOP_APP_ROOT: config.appRoot, LOOP_DATA_ROOT: config.dataRoot,
        },
        allocation: { prepare: async () => {
          config.store.readCommandSubmission(claim); // assert current claim before any spawn
          return {
            containment: { dataRoot: config.dataRoot, allocationId: containmentId },
            attach: (childPid, startMarker, childGroup) => {
              pid = childPid; marker = startMarker || marker; groupId = childGroup || groupId;
              bind(pid, marker, groupId);
            },
            requestTermination: () => undefined,
            finish: (confirmed) => { exitConfirmed = confirmed; },
          };
        } },
        processes: {
          register: async (_run, childPid) => {
            const identity = await waitForProcessIdentity(childPid);
            if (!identity) throw new Error('Admin CLI identity could not be confirmed');
            marker = identity.startMarker;
            bind(childPid, marker, groupId);
            return marker;
          },
          markExited: async () => undefined,
          terminate: stopPhysical,
          confirmExit: stopPhysical,
        },
        recordTelemetryEvent: async (event) => {
          const safe = JSON.parse(JSON.stringify(config.telemetry.sanitize(event)).replaceAll(credential.token, '[REDACTED]'));
          config.store.recordEvidence(claim, `tool-${event.sequence}`, 'finding', { event: safe });
        },
      });
      const completion = invocation.then((execution): AdminExecutionCompletion => {
        if (execution.cancelled || cancellation.signal.aborted) return { outcome: 'failed', reason: 'Admin execution stopped', exitConfirmed: exitConfirmed || !pid };
        if (execution.evidencePersistenceError) return { outcome: 'failed', reason: `Admin evidence persistence failed: ${execution.evidencePersistenceError}`, exitConfirmed };
        if (execution.logPersistenceError) config.store.recordEvidence(claim, 'log-persistence-failure', 'finding', { error: execution.logPersistenceError });
        const submission = config.store.readCommandSubmission(claim);
        if (submission?.outcome === 'verification-requested' || submission?.outcome === 'diagnosis-requested'
          || submission?.outcome === 'external-wait-requested') return { outcome: submission.outcome, reason: submission.summary, exitConfirmed };
        return { outcome: 'failed', exitConfirmed,
          reason: submission?.summary || execution.failureDetail || execution.terminationReason || `Admin CLI exit ${execution.exitCode} without terminal submission` };
      }).catch((error): AdminExecutionCompletion => ({ outcome: 'failed', exitConfirmed: exitConfirmed || !pid, reason: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          signal.removeEventListener('abort', abort);
          removeAgentExecutionTempDirectory(temporary);
        });
      return { completion, stop: async () => { abort(); return stopPhysical(); } };
    } catch (error) {
      // All synchronous preparation precedes invocation. This adapter knows
      // no child was spawned, unlike a generic Controller launch rejection.
      if (preparedTemporary) removeAgentExecutionTempDirectory(preparedTemporary);
      removeAbortListener?.();
      return { completion: Promise.resolve({ outcome: 'failed', exitConfirmed: true,
        reason: error instanceof Error ? error.message : String(error) }), stop: async () => true };
    }
  };
}
