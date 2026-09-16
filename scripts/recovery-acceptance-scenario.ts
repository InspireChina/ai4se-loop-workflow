import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { auditRecoveryAcceptance } from '../src/infrastructure/recovery-acceptance-audit';
import {
  acceptanceTaskDescription,
  readRecoveryScenarioState,
  RECOVERY_ACCEPTANCE_ACK,
  RECOVERY_ACCEPTANCE_MODES,
  type RecoveryAcceptanceMode,
} from '../src/infrastructure/recovery-acceptance-scenario';
import { AdminManagementStore } from '../src/infrastructure/admin-management-store';
import { readHarnessArtifact } from './harness-artifact.mjs';

type Executor = 'cursor' | 'codex' | 'claude' | 'omp';
const allowed = new Set(['--ack', '--app-root', '--data-root', '--evidence-root', '--executor', '--host-executable',
  '--mode', '--real-cli', '--scenario-id', '--timeout-minutes', '--workspace', '--failure-command', '--stale-url']);

function parse(raw: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index], value = raw[index + 1];
    if (!allowed.has(key) || !value || values.has(key)) throw new Error(`Invalid or duplicate argument: ${key || '<empty>'}`);
    values.set(key, value);
  }
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(`Missing ${key}`); return value; };
  if (required('--ack') !== RECOVERY_ACCEPTANCE_ACK) throw new Error(`Refusing without --ack ${RECOVERY_ACCEPTANCE_ACK}`);
  const absolute = (key: string) => { const value = required(key); if (!isAbsolute(value)) throw new Error(`${key} must be absolute`); return resolve(value); };
  const mode = required('--mode') as RecoveryAcceptanceMode;
  if (!RECOVERY_ACCEPTANCE_MODES.includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  const executor = required('--executor') as Executor;
  if (!['cursor', 'codex', 'claude', 'omp'].includes(executor)) throw new Error(`Unsupported executor: ${executor}`);
  const timeoutMinutes = Number(values.get('--timeout-minutes') || '180');
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 10 || timeoutMinutes > 720) throw new Error('--timeout-minutes must be an integer from 10 to 720');
  const scenarioId = values.get('--scenario-id') || `${mode}-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(scenarioId)) throw new Error('Invalid --scenario-id');
  const result = { mode, executor, timeoutMinutes, scenarioId, appRoot: absolute('--app-root'), dataRoot: absolute('--data-root'),
    evidenceRoot: absolute('--evidence-root'), workspace: absolute('--workspace'), hostExecutable: absolute('--host-executable'),
    realCli: absolute('--real-cli'), failureCommand: values.get('--failure-command') || 'npm test',
    staleUrl: values.get('--stale-url') || 'http://127.0.0.1:9' };
  if (!existsSync(result.realCli) || !existsSync(result.hostExecutable)) throw new Error('Host executable and real CLI must exist');
  if (existsSync(result.dataRoot) && readdirSync(result.dataRoot).length) throw new Error('Acceptance data root must be new or empty');
  if (existsSync(result.evidenceRoot) && readdirSync(result.evidenceRoot).length) throw new Error('Evidence root must be new or empty');
  return result;
}

function atomicJson(filename: string, value: unknown) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filename);
}

function initializeWorkspace(workspace: string, mode: RecoveryAcceptanceMode, scenarioId: string) {
  if (existsSync(workspace) && readdirSync(workspace).length) throw new Error('Acceptance workspace must be new or empty');
  mkdirSync(join(workspace, 'src'), { recursive: true, mode: 0o700 });
  mkdirSync(join(workspace, 'test'), { recursive: true, mode: 0o700 });
  const healthy = mode !== 'dev-missing';
  writeFileSync(join(workspace, '.loopwork-recovery-acceptance.json'), `${JSON.stringify({ schema: 1, scenarioId, mode }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(workspace, 'package.json'), `${JSON.stringify({ name: `loopwork-recovery-${scenarioId}`, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(workspace, 'README.md'), `# Isolated recovery acceptance\n\nImplement and preserve \`add(left, right)\` for two finite JavaScript numbers so it returns their numeric sum and the authoritative \`npm test\` command passes. Non-number inputs are explicitly out of scope.\n`, { mode: 0o600 });
  writeFileSync(join(workspace, 'src', 'math.js'), healthy ? 'export const add = (left, right) => left + right;\n' : 'export const add = (_left, _right) => 0;\n', { mode: 0o600 });
  writeFileSync(join(workspace, 'test', 'math.test.js'), `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.js';\ntest('adds two values', () => assert.equal(add(20, 22), 42));\n`, { mode: 0o600 });
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  };
  git(['init', '-b', 'main']); git(['add', '.']);
  git(['-c', 'user.name=LoopWork Recovery Acceptance', '-c', 'user.email=recovery-acceptance@loopwork.invalid', 'commit', '-m', 'acceptance baseline']);
}

function openReadOnly(filename: string) { return new Database(filename, { readonly: true, fileMustExist: true }); }
const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolveDelay, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Acceptance scenario interrupted')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolveDelay(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

async function waitForReady(child: ChildProcess, timeoutMs: number) {
  return new Promise<Record<string, unknown>>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('External host readiness timed out')), timeoutMs);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit);
      if (error) reject(error); else resolveReady(value!);
    };
    const onMessage = (message: unknown) => {
      if (message && typeof message === 'object' && (message as { kind?: string }).kind === 'external-host-ready') finish(undefined, message as Record<string, unknown>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`External host exited before readiness: code=${code} signal=${signal}`));
    child.on('message', onMessage); child.once('exit', onExit);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode) return true;
  return new Promise<boolean>(resolveExit => {
    const timer = setTimeout(() => { child.off('exit', exited); resolveExit(false); }, timeoutMs);
    const exited = () => { clearTimeout(timer); resolveExit(true); };
    child.once('exit', exited);
  });
}

async function main() {
  const options = parse(process.argv.slice(2));
  const interruption = new AbortController();
  const interrupt = () => interruption.abort(new Error('Acceptance scenario interrupted by SIGINT/SIGTERM'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  mkdirSync(options.dataRoot, { recursive: true, mode: 0o700 }); mkdirSync(options.evidenceRoot, { recursive: true, mode: 0o700 });
  initializeWorkspace(options.workspace, options.mode, options.scenarioId);
  const artifact = await readHarnessArtifact(options.appRoot);
  process.env.LOOP_APP_ROOT = options.appRoot; process.env.LOOP_DATA_ROOT = options.dataRoot;
  process.env.LOOP_GLOBAL_DB_PATH = join(options.dataRoot, 'loop-ui.db'); process.env.LOOP_WORKSPACE_ROOT_OVERRIDE = options.workspace;
  const [{ createTask }, { listProjects, setDefaultProject }, settings] = await Promise.all([
    import('../src/application/tasks'), import('../src/application/projects'), import('../src/application/project-settings'),
  ]);
  const project = (await listProjects()).find(row => row.workspace_root === options.workspace);
  if (!project) throw new Error('Business database did not initialize the isolated workspace project');
  await setDefaultProject(project.project_id);
  const runtime = { executorId: options.executor, codexModel: 'gpt-5.6-luna', codexReasoningEffort: 'high', codexWebSearch: false,
    claudeModel: '', ompModel: '', ompThinking: 'high' } as const;
  await settings.setFlowAgentDefaultRuntimeSettings(runtime); await settings.setAgentExecutorSettings(runtime);
  const taskId = await createTask({ title: `[Recovery acceptance] ${options.mode}`, itemType: 'bug', actor: 'human', projectId: project.project_id,
    description: acceptanceTaskDescription(options.mode, options.failureCommand, options.staleUrl) });
  const management = new AdminManagementStore(join(options.dataRoot, 'admin-management.db'));
  management.setIntent('running', `acceptance-start:${options.scenarioId}`); management.close();

  const wrapper = resolve('scripts/recovery-fault-injection-agent.mjs');
  const cliVariable = ({ cursor: 'CURSOR_CLI', codex: 'CODEX_CLI', claude: 'CLAUDE_CLI', omp: 'OMP_CLI' } as const)[options.executor];
  const statePath = join(options.evidenceRoot, 'fault-state.json');
  const stdoutPath = join(options.evidenceRoot, 'external-host.stdout.log'), stderrPath = join(options.evidenceRoot, 'external-host.stderr.log');
  const stdout = openSync(stdoutPath, 'wx', 0o600), stderr = openSync(stderrPath, 'wx', 0o600);
  const child = spawn(options.hostExecutable, [join(options.appRoot, 'desktop-runners', 'external-host.cjs'), '--app-root', options.appRoot,
    '--data-root', options.dataRoot, '--electron-node', options.hostExecutable], {
    // The installed app root can be atomically replaced by a concurrent build.
    // Keep the long-lived external root on its own stable directory; every
    // executable and artifact input is already passed as an absolute path.
    cwd: options.dataRoot, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', stdout, stderr, 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LOOP_APP_ROOT: options.appRoot, LOOP_DATA_ROOT: options.dataRoot,
      LOOP_GLOBAL_DB_PATH: join(options.dataRoot, 'loop-ui.db'), [cliVariable]: wrapper,
      LOOP_RECOVERY_FAULT_ACK: RECOVERY_ACCEPTANCE_ACK, LOOP_RECOVERY_FAULT_MODE: options.mode,
      LOOP_RECOVERY_FAULT_STATE: statePath, LOOP_RECOVERY_REAL_CLI: options.realCli, LOOP_RECOVERY_FAULT_LIMIT: '2',
      LOOP_RECOVERY_FAILURE_COMMAND: options.failureCommand, LOOP_RECOVERY_FAILURE_SUMMARY: `${options.scenarioId}: authoritative failure`,
      LOOP_RECOVERY_STALE_SERVICE_URL: options.staleUrl, LANGFUSE_ENABLED: 'false', NODE_OPTIONS: '' },
  });
  closeSync(stdout); closeSync(stderr);
  let success = false; let ready: Record<string, unknown> | undefined; let lastState: ReturnType<typeof readRecoveryScenarioState> | undefined;
  const startedAt = Date.now(), deadline = startedAt + options.timeoutMinutes * 60_000;
  try {
    ready = await Promise.race([waitForReady(child, 120_000), new Promise<never>((_, reject) => {
      const abort = () => reject(interruption.signal.reason);
      if (interruption.signal.aborted) abort(); else interruption.signal.addEventListener('abort', abort, { once: true });
    })]);
    while (Date.now() < deadline) {
      interruption.signal.throwIfAborted();
      const admin = openReadOnly(join(options.dataRoot, 'admin-management.db')), business = openReadOnly(join(options.dataRoot, 'loop-ui.db'));
      try { lastState = readRecoveryScenarioState(admin, business, taskId); }
      finally { business.close(); admin.close(); }
      atomicJson(join(options.evidenceRoot, 'scenario-checkpoint.json'), { schema: 'loop-recovery-acceptance-scenario/v1', scenarioId: options.scenarioId,
        mode: options.mode, taskId, artifact, ready, startedAt, updatedAt: Date.now(), complete: lastState.complete, state: lastState });
      if (lastState.complete) { success = true; break; }
      if (child.exitCode !== null || child.signalCode) throw new Error(`External host exited during scenario: code=${child.exitCode} signal=${child.signalCode}`);
      await delay(5_000, interruption.signal);
    }
    if (!success) throw new Error(`Scenario did not complete within ${options.timeoutMinutes} minutes`);
  } finally {
    const stop = new AdminManagementStore(join(options.dataRoot, 'admin-management.db'));
    try { stop.setIntent('stopped', `acceptance-stop:${options.scenarioId}`); } finally { stop.close(); }
    await delay(12_000);
    if (child.connected) child.send({ kind: 'shutdown-host' }); else child.kill('SIGTERM');
    if (!await waitForExit(child, 35_000)) { child.kill('SIGTERM'); if (!await waitForExit(child, 10_000)) child.kill('SIGKILL'); }
  }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  const admin = openReadOnly(join(options.dataRoot, 'admin-management.db')), business = openReadOnly(join(options.dataRoot, 'loop-ui.db'));
  try {
    const caseIds = lastState?.caseIds || [];
    const audit = auditRecoveryAcceptance(admin, business, { expectStopped: true, requiredCaseIds: caseIds });
    const report = { schema: 'loop-recovery-acceptance-scenario/v1', scenarioId: options.scenarioId, mode: options.mode, taskId,
      artifact, ready, startedAt, finishedAt: Date.now(), state: lastState, audit, passed: success && caseIds.length > 0 && audit.passed };
    atomicJson(join(options.evidenceRoot, 'scenario-final.json'), report); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 2;
  } finally { business.close(); admin.close(); }
}

void main().catch(error => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });
