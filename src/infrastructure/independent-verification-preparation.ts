import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { AdminControllerPorts, AdminExecutionCompletion } from '../application/admin-controller';
import { authorizePreparedVerification, independentPreparationPrompt, originalVerificationTargets } from '../domain/independent-verification-preparation';
import { createRepairActivityMonitor } from '../domain/repair-activity';
import type { AgentExecutor, AgentExecutionOptions } from './agent-executor';
import { adminBusinessEnvironmentBoundary } from './admin-execution';
import { executeAgentInvocation } from './agent-invocation';
import type { AdminManagementStore } from './admin-management-store';
import { sanitizeDiagnosticText } from './diagnostic-text';
import type { resolveAgentExecutionLimits } from './agent-execution-limits';
import { createLangfuseTelemetry } from './langfuse';
import { confirmAdminAttemptStopped } from './admin-execution';
import { inspectProcessGroup, terminateProcessGroup, terminateProcessTree, waitForProcessIdentity } from './process-tree';
import {confirmWindowsJobContainmentExit} from './windows-job-containment';
import { readRepairWorkspaceVersion, workspaceVersionCommand,readRuntimeArtifactVersion,runtimeArtifactVersionCommand } from './repair-workspace-version';
import { readVerificationArtifacts } from './verification-artifacts';

function contained(root: string, target: string) {
  const path = relative(root, target);
  if (path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path)) {
    throw new Error('独立验收文件越过已接管工作区');
  }
}

/** This is a separate, durable Test invocation with NO Admin or business
 * credentials. It authors checks against original contracts; a later native
 * worker actually executes them. Model summary/exit 0 is never a pass. */
export function createIndependentVerificationPreparation(config: {
  store: AdminManagementStore; appRoot: string; dataRoot: string;
  toolRoot?: string;
  executor: AgentExecutor; executionOptions: AgentExecutionOptions;
  limits: ReturnType<typeof resolveAgentExecutionLimits>;
}): AdminControllerPorts['launch'] {
  return async (claim, bind, signal) => {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let pid = 0;
    let marker: string | undefined;
    let groupId: number | undefined;
    let physicalExit = false;
    const containmentId=`preparation-${claim.attempt.attemptId}`;
    const assertCurrent = () => { config.store.assertIndependentVerificationClaim(claim); cancellation.signal.throwIfAborted(); };
    const stopPhysical = async () => {
      if (!pid) return true;
      if (groupId) {
        if (!marker) { const members = await inspectProcessGroup(groupId); return Boolean(members && members.length === 0); }
        return terminateProcessGroup(groupId, 5000, marker);
      }
      if(process.platform==='win32')return confirmWindowsJobContainmentExit({dataRoot:config.dataRoot,
        process:{allocationId:containmentId,pid,marker:marker??null}});
      return confirmAdminAttemptStopped({ ...claim.attempt, pid, startMarker: marker || null, processGroupId: null });
    };
    const stop = async () => { abort(); return stopPhysical(); };
    try {
      const input = config.store.independentVerificationInput(claim);
      const readVersion=()=>input.kind==='runtime'?readRuntimeArtifactVersion(input.runtimeBinding.candidate,{signal:cancellation.signal,assertCurrent})
        :readRepairWorkspaceVersion(input.workspaceRoot,{signal:cancellation.signal,assertCurrent});
      const root = await realpath(input.workspaceRoot);
      const scratch = join(root, '.tmp');
      try { contained(root, await realpath(scratch)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      contained(root, await realpath(scratch));
      const directory = join(scratch, `independent-${claim.attempt.attemptId}`);
      await mkdir(directory, { mode: 0o700 }); // unique physical attempt; never reuse an Agent's directory
      contained(root, await realpath(directory));
      const originalFile = join(directory, 'original-facts.json');
      const resultFile = join(directory, 'verification-plan.json');
      const originalText = JSON.stringify({ input, targets: originalVerificationTargets(input) }, null, 2);
      await writeFile(originalFile, originalText, { mode: 0o400, flag: 'wx' });
      const version = await readVersion();
      if (version !== input.expectedVersion) throw new Error('独立验收准备前实际版本与修复提交不一致');
      assertCurrent();
      const logDirectory = join(config.dataRoot, 'admin', 'logs');
      await mkdir(logDirectory, { recursive: true });
      const monitor = createRepairActivityMonitor({ now: Date.now, timeoutMs: 20 * 60 * 1000, longToolTimeoutMs: 20 * 60 * 1000,
        known: operation => config.store.knownActivityCheckpoint(claim, operation),
        checkpoint: operation => config.store.recordActivityCheckpoint(claim, operation) });
      const telemetry = createLangfuseTelemetry({ env: { LANGFUSE_ENABLED: 'false' } });
      const invocation = executeAgentInvocation({
        runId: claim.repairCase.caseId, workspaceRoot: root,
        prompt: independentPreparationPrompt(input, originalFile, resultFile),
        executor: { ...config.executor, env: Object.fromEntries(Object.entries(config.executor.env || {})
          .filter(([key]) => !/^LOOP_(?:ADMIN|EXECUTION|INTERNAL|INTERVENTION|VERIFICATION_ASSISTANCE)_/.test(key))) },
        executionOptions: config.executionOptions,
        context: { agent: 'test-agent', taskId: claim.repairCase.scopeKey, storyIndex: null, pipeline: 'independent-repair-verification', lane: 'control' },
        description: 'Prepare independent original-contract checks; not acceptance success',
        telemetry,
        appendLog: message => appendFile(join(logDirectory, `${claim.attempt.attemptId}.log`), `${new Date().toISOString()} ${sanitizeDiagnosticText(message)}\n`),
        ...config.limits, cancellationSignal: cancellation.signal, isolateProcessGroup: process.platform !== 'win32',
        monitor: { ...monitor, intervalMs: 1000, observe: event => monitor.observe({ ...event, input: telemetry.sanitize(event.input) }) },
        environment: { ...adminBusinessEnvironmentBoundary(),
          ...(process.env.LOOP_DESKTOP_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ...Object.fromEntries(Object.keys(process.env).filter(key => /^LOOP_ADMIN_/.test(key)).map(key => [key, undefined])),
          LOOP_AGENT_TMP_DIR: directory, LOOP_APP_ROOT: config.appRoot, LOOP_DATA_ROOT: config.dataRoot },
        allocation: { prepare: async () => { assertCurrent(); return {
          containment: { dataRoot: config.dataRoot, allocationId: containmentId },
          attach: (childPid, startMarker, childGroup) => { pid = childPid; marker = startMarker || marker; groupId = childGroup || groupId; bind(pid, marker, groupId); },
          requestTermination: () => undefined, finish: confirmed => { physicalExit = confirmed; },
        }; } },
        recordTelemetryEvent: async event => { config.store.recordEvidence(claim, `independent-tool-${event.sequence}`, 'finding', { event: telemetry.sanitize(event) }); },
        processes: {
          register: async (_run, childPid) => {
            const identity = await waitForProcessIdentity(childPid);
            if (!identity) throw new Error('Independent Test identity could not be confirmed');
            marker = identity.startMarker; bind(childPid, marker, groupId); return marker;
          },
          markExited: async () => undefined,
          terminate: stopPhysical, confirmExit: stopPhysical,
        },
      });
      const completion = invocation.then(async (execution): Promise<AdminExecutionCompletion> => {
        if (execution.cancelled || cancellation.signal.aborted || execution.exitCode !== 0 || !physicalExit
          || execution.evidencePersistenceError) throw new Error(execution.failureDetail || execution.terminationReason || '独立验收准备失败或实际退出未确认');
        assertCurrent();
        if (await readFile(originalFile, 'utf8') !== originalText) throw new Error('独立验收准备改写了冻结事实文件');
        const info = await lstat(resultFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('独立验收计划必须是有界普通 JSON 文件');
        contained(directory, await realpath(resultFile));
        const proposed: unknown = JSON.parse(await readFile(resultFile, 'utf8'));
        if (await readVersion() !== input.expectedVersion) {
          throw new Error('独立验收准备修改了源码版本，不能授权计划');
        }
        const versionCommand=input.kind==='runtime'?runtimeArtifactVersionCommand(config.toolRoot??config.appRoot,input.runtimeBinding.candidate):workspaceVersionCommand(config.toolRoot??config.appRoot,root);
        const plan = authorizePreparedVerification(input, proposed, versionCommand);
        const artifacts = await readVerificationArtifacts(directory, { workspaceRoot: root, signal: cancellation.signal, assertCurrent });
        config.store.recordVerificationPreparation(claim, input, plan, artifacts);
        return { outcome: 'verification-prepared', reason: '独立验收计划已保存，等待实际复现与验收执行', exitConfirmed: true };
      }).catch((error): AdminExecutionCompletion => ({ outcome: 'failed', reason: sanitizeDiagnosticText(String(error)), exitConfirmed: physicalExit || !pid }))
        .finally(() => signal.removeEventListener('abort', abort));
      // Generated test scripts are retained for native execution and restart.
      // They are not business source and do not disappear on CLI settlement.
      return { completion, stop };
    } catch (error) {
      signal.removeEventListener('abort', abort);
      return { completion: Promise.resolve({ outcome: 'failed', reason: sanitizeDiagnosticText(String(error)), exitConfirmed: !pid }), stop };
    }
  };
}
