import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {mkdir,lstat,realpath} from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdminControllerPorts, AdminExecutionCompletion } from '../application/admin-controller';
import { executeIndependentRepairVerification } from '../application/independent-repair-verification';
import { repairVerificationCheckSchema, type RepairVerificationPlan, type VerificationCommandResult } from '../domain/repair-verification';
import type { RepairClaim } from '../domain/repair-case';
import type { AdminManagementStore } from './admin-management-store';
import { inspectProcessGroup, terminateProcessGroup, terminateProcessTree, waitForProcessIdentity } from './process-tree';
import { sanitizeDiagnosticText } from './diagnostic-text';
import { boundedExecutionLookup } from '../application/bounded-execution-lookup';
import type {RuntimeArtifact} from '../domain/runtime-update';
import {attachWindowsJobContainment,confirmWindowsJobContainmentExit,withWindowsJobAdmission} from './windows-job-containment';

export function verificationWorkerLaunch(appRoot: string) {
  const bundled = join(appRoot, 'desktop-runners', 'verification-worker.cjs');
  return { command: process.env.LOOP_DESKTOP_NODE || process.execPath,
    args: existsSync(bundled) ? [bundled] : ['--import', pathToFileURL(join(appRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      join(appRoot, 'scripts', 'loop', 'verification-worker-entry.ts')] };
}

/** One durable worker/group per verification attempt, not one untracked shell
 * per check. The host authorizes commands and records receipts; the worker
 * never acquires business slots or grants itself workflow completion. */
export type NativeAdminVerificationPorts = {
  store: AdminManagementStore; appRoot: string;
  resolvePlan: (claim: RepairClaim) => Promise<{ plan: RepairVerificationPlan; workspaceRoot: string; runtimeArtifact?:RuntimeArtifact }>;
  commandTimeoutMs?: number;
  planLookupTimeoutMs?: number;
  assertCheckInputs?: (claim: RepairClaim, signal: AbortSignal) => Promise<void>;
};
export function createNativeAdminVerification(ports: NativeAdminVerificationPorts): AdminControllerPorts['launch'] {
  return async (claim, bind, signal) => {
    let resolved: Awaited<ReturnType<typeof ports.resolvePlan>>;
    try {
      if (signal.aborted) throw new Error('Verification cancelled before plan resolution');
      resolved = await boundedExecutionLookup(() => ports.resolvePlan(claim), signal, ports.planLookupTimeoutMs ?? 5000, 'Independent check plan lookup');
      if (signal.aborted) throw new Error('Verification cancelled before physical launch');
      ports.store.recordVerificationPlan(claim, resolved.plan);
      if(resolved.runtimeArtifact) {
        const input=ports.store.independentVerificationInput(claim);
        if(input.kind!=='runtime'||JSON.stringify(input.runtimeBinding.candidate)!==JSON.stringify(resolved.runtimeArtifact))throw new Error('实际 runtime 执行产物未绑定当前独立验收来源');
      }
    } catch (error) {
      return { completion: Promise.resolve({ outcome: 'failed', reason: sanitizeDiagnosticText(String(error)), exitConfirmed: true }), stop: async () => true };
    }
    const launch = verificationWorkerLaunch(ports.appRoot);
    let env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
    const containmentDataRoot=dirname(ports.store.filename);
    const containmentId=`verification-${claim.attempt.attemptId}`;
    // Electron's main host does not inherit the server's Node-mode flag.
    // This child is a Node worker, never another desktop application window.
    if (process.env.LOOP_DESKTOP_NODE) env.ELECTRON_RUN_AS_NODE = '1';
    for (const key of Object.keys(env)) if (/^LOOP_(?:ADMIN|EXECUTION|INTERNAL|INTERVENTION|VERIFICATION_ASSISTANCE)_/.test(key)) delete env[key];
    if(resolved.runtimeArtifact) {
      try {
        // Execute compiled candidate entries in a separate private data root.
        // Neither inherited DB overrides nor ordinary service defaults may
        // migrate the live business/management databases during verification.
        const dataRoot=await realpath(dirname(ports.store.filename));
        let parent=dataRoot;
        for(const segment of ['admin','verification-runs',claim.attempt.attemptId]) {
          parent=join(parent,segment);await mkdir(parent,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
          const info=await lstat(parent);
          if(!info.isDirectory()||info.isSymbolicLink()||await realpath(parent)!==parent)throw new Error('runtime 验证数据目录不是本轮实际私有路径');
        }
        ports.store.assertIndependentVerificationClaim(claim);signal.throwIfAborted();
        for(const key of Object.keys(env))if(key.startsWith('LOOP_'))delete env[key];
        env.LOOP_APP_ROOT=resolved.runtimeArtifact.root;env.LOOP_DATA_ROOT=parent;
      } catch(error) {
        return {completion:Promise.resolve({outcome:'failed',reason:sanitizeDiagnosticText(String(error)),exitConfirmed:true}),stop:async()=>true};
      }
    }
    env=withWindowsJobAdmission(env,containmentDataRoot,containmentId);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, { cwd: ports.appRoot, env,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    } catch (error) {
      return { completion: Promise.resolve({ outcome: 'failed', reason: String(error), exitConfirmed: true }), stop: async () => true };
    }
    let marker: string | undefined;
    let closed = false;
    let launchFailedWithoutPid = false;
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => undefined);
    let pending: { id: string; resolve: (value: VerificationCommandResult) => void; reject: (error: Error) => void } | undefined;
    let workerStderr = '';
    let commandStdoutTail = '';
    let commandStderrTail = '';
    child.stdout?.on('data', () => undefined);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { workerStderr = (workerStderr + chunk).slice(-16000); });
    const failed = (error: Error) => { readyReject(error); pending?.reject(error); pending = undefined; };
    child.once('error', error => { launchFailedWithoutPid = !child.pid; failed(error); });
    child.once('close', code => { closed = true; failed(new Error(`Verification worker exited ${code}: ${sanitizeDiagnosticText(workerStderr)}`)); });
    child.on('message', (input: unknown) => {
      const message = input as { kind?: string; id?: string; result?: VerificationCommandResult; message?: string; stream?: string; text?: string };
      if (message.kind === 'ready') readyResolve();
      else if (message.kind === 'output' && pending && pending.id === message.id && typeof message.text === 'string'
        && (message.stream === 'stdout' || message.stream === 'stderr')) {
        if (message.stream === 'stdout') commandStdoutTail = (commandStdoutTail + message.text).slice(-32000);
        else commandStderrTail = (commandStderrTail + message.text).slice(-32000);
      }
      else if (message.kind === 'result' && pending && pending.id === message.id && message.result) {
        const current = pending; pending = undefined; current.resolve(message.result);
      } else failed(new Error(message.message || 'Unexpected verification worker message'));
    });
    const pid = child.pid;
    const groupId = process.platform !== 'win32' ? pid : undefined;
    const stop = async () => {
      if (!pid) return closed || launchFailedWithoutPid;
      if (groupId) return terminateProcessGroup(groupId, 5000, marker);
      if(process.platform==='win32')return confirmWindowsJobContainmentExit({dataRoot:containmentDataRoot,
        process:{allocationId:containmentId,pid,marker:marker??null}});
      if (!marker || closed) return false;
      return terminateProcessTree(pid, 5000, marker);
    };
    const abort = () => { failed(new Error('Independent verification stopped')); void stop().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    const completion = (async (): Promise<AdminExecutionCompletion> => {
      let readyTimer: NodeJS.Timeout | undefined;
      try {
        if (!pid) { await ready; throw new Error('Verification worker PID unavailable'); }
        if(!await attachWindowsJobContainment({dataRoot:containmentDataRoot,allocationId:containmentId,pid}))
          throw new Error('Verification worker could not enter its Windows Job container');
        bind(pid, undefined, groupId); // immediate ownership before any async identity query
        const identity = await waitForProcessIdentity(pid);
        if (!identity) throw new Error('Verification worker identity could not be confirmed');
        marker = identity.startMarker;
        bind(pid, marker, groupId);
        await Promise.race([ready, new Promise<never>((_, reject) => {
          readyTimer = setTimeout(() => reject(new Error('Verification worker startup timed out')), 30000);
        })]);
        if (readyTimer) clearTimeout(readyTimer);
        const baseline = groupId ? await inspectProcessGroup(groupId) : null;
        if (groupId && !baseline?.some(member => member.pid === pid && member.startMarker === marker)) {
          throw new Error('Verification worker process group identity unavailable');
        }
        // Source-mode tsx can keep an esbuild service alive. Those trusted
        // pre-command helpers belong to this worker and are killed at final
        // cleanup, but are not leftovers created by a verification command.
        const baselineIdentities = new Map((baseline || []).map(member => [member.pid, member.startMarker]));
        ports.store.recordEvidence(claim, 'verification-worker-baseline', 'verification-process-check', { pid, marker, baseline });
        let ordinal = 0;
        const receipt = await executeIndependentRepairVerification(resolved.plan, {
          signal,
          continueOnCheckFailure: ports.store.verificationPurpose(claim.attempt.attemptId) === 'diagnosis',
          persist: async (key, evidence) => { ports.store.recordEvidence(claim, key, key === 'verification-plan' ? 'verification-plan' : 'verification-check', evidence); },
          run: async command => {
            if (signal.aborted) throw new Error('Independent verification stopped');
            await ports.assertCheckInputs?.(claim, signal);
            const id = `command-${ordinal++}`;
            commandStdoutTail = ''; commandStderrTail = '';
            ports.store.recordEvidence(claim, `verification-start-${id}`, 'verification-start', { command });
            const raw = await new Promise<VerificationCommandResult>((resolve, reject) => {
              const timer = setTimeout(() => { pending = undefined; reject(new Error(`Verification command timed out: ${id}`)); }, ports.commandTimeoutMs ?? 20 * 60 * 1000);
              pending = { id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
              child.send({ id, command, workspaceRoot: resolved.runtimeArtifact?.root || resolved.workspaceRoot }, error => { if (error) failed(error); });
            });
            await ports.assertCheckInputs?.(claim, signal);
            let members = groupId ? await inspectProcessGroup(groupId) : null;
            const initialMembers = members;
            // close can precede a very short OS reaping tail. Re-inspect the
            // SAME owned group; never reinterpret a timeout as physical exit.
            const deadline = Date.now() + 500;
            const isBaseline = (member: { pid: number; startMarker: string }) => baselineIdentities.get(member.pid) === member.startMarker;
            while (members && members.some(member => member.pid === pid && member.startMarker === marker)
              && members.some(member => !isBaseline(member)) && Date.now() < deadline && !signal.aborted) {
              await new Promise(resolve => setTimeout(resolve, 20));
              members = await inspectProcessGroup(groupId!);
            }
            ports.store.recordEvidence(claim, `verification-process-check-${id}`, 'verification-process-check', { pid, marker, initialMembers, members });
            const exitConfirmed = Boolean(members && members.some(member => member.pid === pid && member.startMarker === marker)
              && members.every(isBaseline));
            // Validate the IPC shape before it reaches evidence storage.
            return repairVerificationCheckSchema.parse({ kind: 'reproduction', targetRef: id, command, result: { ...raw, exitConfirmed } }).result;
          },
        });
        await ports.assertCheckInputs?.(claim, signal);
        ports.store.recordVerificationReceipt(claim, receipt); // crash recovery before cleanup/settlement
        return { outcome: receipt.passed ? 'verified' : 'failed', reason: receipt.reason, exitConfirmed: await stop() };
      } catch (error) {
        const reason = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
        try {
          ports.store.recordEvidence(claim, 'verification-execution-failure', 'finding', {
            reason, stdoutTail: sanitizeDiagnosticText(commandStdoutTail), stderrTail: sanitizeDiagnosticText(commandStderrTail),
            workerStderr: sanitizeDiagnosticText(workerStderr),
          });
        } catch { /* Failed/stale diagnostic writes cannot block physical termination. */ }
        return { outcome: 'failed', reason, exitConfirmed: await stop() };
      } finally {
        if (readyTimer) clearTimeout(readyTimer);
        signal.removeEventListener('abort', abort);
      }
    })();
    if (signal.aborted) abort();
    return { completion, stop };
  };
}
