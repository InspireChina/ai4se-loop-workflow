import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { sanitizeDiagnosticText } from '../../src/infrastructure/diagnostic-text';
import { createHostParentWatch } from '../../src/application/host-parent-watch';
import { AdminManagementStore } from '../../src/infrastructure/admin-management-store';
import { readHarnessArtifact } from '../harness-artifact.mjs';
import {selectInstalledRuntime} from '../../src/infrastructure/runtime-selection';
import {spawn} from 'node:child_process';
import {assertRuntimeDataOutside} from '../../src/infrastructure/runtime-paths';
import type { RuntimeUpdateProcess, RuntimeUpdateAuthority, RuntimeHostProcess } from '../../src/domain/runtime-update';
import {runtimeUpdateIdSchema} from '../../src/domain/runtime-update';
import {waitForWindowsJobAdmission} from '../../src/infrastructure/windows-job-containment';

/** No Web listener, no direct business status writes and no implicit start.
 * Initialize roots BEFORE importing production composition/database paths. */
async function main() {
  await waitForWindowsJobAdmission();
  const raw = process.argv.slice(2);
  const args = new Map<string, string>();
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index]; const value = raw[index + 1];
    if (!key || !['--app-root', '--data-root', '--electron-node','--watch-parent','--external-update','--allocation-id','--host-allocation'].includes(key) || !value || args.has(key)) throw new Error('无效或重复的独立宿主参数');
    if (key === '--watch-parent') {
      if (!/^[1-9]\d*$/.test(value) || Number(value) !== process.ppid) throw new Error('父宿主必须绑定实际启动父进程');
    } else if (key === '--external-update' || key === '--allocation-id' || key === '--host-allocation') {
      if (!runtimeUpdateIdSchema.safeParse(value).success) throw new Error('无效外部更新分配标识');
    } else if (!isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error('独立宿主路径必须是绝对路径');
    args.set(key, value);
  }
  if (args.has('--external-update') !== args.has('--allocation-id') || args.has('--external-update') && (!process.send || !process.connected)) throw new Error('外部更新启动必须绑定私有父进程通道与持久化分配');
  if(args.has('--host-allocation')&&(args.has('--external-update')||!process.send||!process.connected))throw new Error('普通外部宿主必须绑定独立私有分配');
  const appRoot = resolve(args.get('--app-root') || process.env.LOOP_APP_ROOT || process.cwd());
  const dataRoot = resolve(args.get('--data-root') || process.env.LOOP_DATA_ROOT || join(appRoot, 'data'));
  const standardHost=args.has('--host-allocation')&&process.env.LOOP_RUNTIME_SAFETY==='standard';
  if(!args.has('--external-update')&&!standardHost) {
    const selected=await selectInstalledRuntime(appRoot,dataRoot);
    if(resolve(selected.root)!==appRoot) {
      // Do not merely change LOOP_APP_ROOT while executing old bundled code.
      // The stable bootstrap delegates to the selected artifact's real entry.
      args.set('--app-root',selected.root);args.set('--data-root',dataRoot);
      if(args.has('--watch-parent'))args.set('--watch-parent',String(process.pid));
      const child=spawn(process.execPath,[join(selected.root,'desktop-runners','host-service.cjs'),...[...args].flat()],{
        env:{...process.env,LOOP_APP_ROOT:selected.root,LOOP_DATA_ROOT:dataRoot,LOOP_GLOBAL_DB_PATH:join(dataRoot,'loop-ui.db')},
        stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
      const stop=()=>{if(child.connected)child.send({kind:'shutdown-host'},()=>undefined);};
      process.once('SIGTERM',stop);process.once('SIGINT',stop);
      process.once('disconnect',stop);
      process.on('message',message=>{if(message&&typeof message==='object'&&'kind'in message&&message.kind==='shutdown-host')stop();});
      child.on('message',message=>{if(process.connected)process.send?.(message,()=>undefined);});
      await new Promise<void>((resolve,reject)=>{
        child.once('error',reject);child.once('close',code=>{process.exitCode=code??1;if(process.connected)process.disconnect();resolve();});
      });return;
    }
  }
  if(args.has('--external-update')) {
    await assertRuntimeDataOutside(appRoot,dataRoot);
  }
  process.env.LOOP_APP_ROOT = appRoot; process.env.LOOP_DATA_ROOT = dataRoot;
  // Explicit data-root owns ALL service databases. An inherited legacy
  // override must not silently redirect a test/host to another workspace.
  process.env.LOOP_GLOBAL_DB_PATH = join(dataRoot, 'loop-ui.db');
  if (args.has('--electron-node')) {
    // This process is an Electron executable running in Node mode. Mark the
    // installed runtime explicitly so every later child resolves the bundled
    // CJS entrypoint instead of looking for source-only tsx/TypeScript files.
    process.env.LOOP_DESKTOP = '1';
    process.env.LOOP_DESKTOP_NODE = args.get('--electron-node');
    process.env.ELECTRON_RUN_AS_NODE = '1';
  }
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  let writes = Promise.resolve();
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
  const log = (kind: string, detail: Record<string, unknown> = {}) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), kind, pid: process.pid, ...detail })}\n`;
    try { process.stdout.write(line); } catch { /* OS logging cannot block cancellation */ }
    writes = writes.catch(() => undefined).then(() => appendFile(join(dataRoot, 'host-service.log'), line, { mode: 0o600 }))
      .catch(error => { process.stderr.write(`${sanitizeDiagnosticText(error)}\n`); });
  };
  let lifecycle: ReturnType<typeof import('../../src/infrastructure/runtime-supervision').createManagedLoopRunLifecycle> | undefined;
  let closing: Promise<void> | undefined;
  let parentWatch: ReturnType<typeof createHostParentWatch> | undefined;
  let updateStore: AdminManagementStore | undefined;
  let updateProcess: RuntimeUpdateProcess | undefined;
  let normalProcess:RuntimeHostProcess|undefined;
  let normalFence:NodeJS.Timeout|undefined;
  let rpc = Promise.resolve();
  const sendPrivate=(message:Record<string,unknown>)=>{
    if(!process.connected)return;
    try {process.send?.(message,error=>{if(error&&!closing)void shutdown(error);});}
    catch(error){if(!closing)void shutdown(error);}
  };
  const keepAlive = setInterval(() => log('host-heartbeat'), 30_000);
  function shutdown(failure?: unknown) {
    if (closing) return closing;
    parentWatch?.stop();
    const error = failure && sanitizeDiagnosticText(failure instanceof Error ? failure.stack || failure.message : failure);
    if (error) { process.exitCode = 1; log('host-fatal', { error }); }
    closing = (async () => {
      // The external service manager is the final watchdog. A timed-out root
      // exit does NOT assert descendant exit or release persistent barriers.
      const watchdog = setTimeout(() => { log('host-shutdown-timeout'); process.exit(1); }, 30_000);
      let cleaned = false;
      try {
        await lifecycle?.shutdown(true);
        cleaned = true;
        log('host-stopped', { preservesUserIntent: true });
        let flush: NodeJS.Timeout | undefined;
        try { await Promise.race([writes, new Promise<void>(resolve => { flush = setTimeout(resolve, 1_000); })]); }
        finally { if (flush) clearTimeout(flush); }
      } catch (error) { process.exitCode = 1; log('host-shutdown-failed', { error: sanitizeDiagnosticText(error) }); }
      finally { if (normalFence)clearInterval(normalFence);if (cleaned) { clearTimeout(watchdog); updateStore?.close(); } clearInterval(keepAlive); if (cleaned && process.connected) process.disconnect(); }
    })();
    return closing;
  }
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  if (process.send) {
    // Private parent IPC also permits graceful Windows host replacement,
    // where child.kill(SIGTERM) force-terminates rather than delivering a hook.
    process.on('message', message => {
      if (!message || typeof message !== 'object' || !('kind' in message)) return;
      if (message.kind === 'shutdown-host') { void shutdown(); return; }
      if (!['activate-update-host','probe-update-host'].includes(String(message.kind)) || !updateProcess || !('requestId' in message) || !('authority' in message)) return;
      const requestId=String(message.requestId);const authority=message.authority as RuntimeUpdateAuthority;
      rpc=rpc.then(async()=>{
        try {
          if(closing||!lifecycle||!requestId||requestId.length>200||!authority||authority.updateId!==updateProcess!.authority.updateId
            ||authority.ownerId!==updateProcess!.authority.ownerId||authority.token!==updateProcess!.authority.token)throw new Error('外部更新激活请求不匹配持有代次');
          updateStore!.assertRuntimeUpdate(authority);
          if(message.kind==='probe-update-host'){
            const snapshot=await lifecycle.status();updateStore!.assertRuntimeUpdate(authority);
            if(closing)throw new Error('健康探测期间宿主已停止');
            const pkg=JSON.parse(await readFile(join(appRoot,'package.json'),'utf8'));
            updateStore!.assertRuntimeUpdate(authority);
            sendPrivate({kind:'update-host-health',requestId,allocationId:updateProcess!.allocationId,pid:process.pid,
              artifactId:updateProcess!.artifact.artifactId,health:{version:pkg.version,owner:snapshot.supervision.owner,
                token:snapshot.supervision.token,leaseExpiresAt:snapshot.supervision.leaseExpiresAt,
                managementMode:updateStore!.control().management_mode,businessMode:snapshot.mode.kind,
                updatePending:updateStore!.activeRuntimeUpdate()?.request.updateId===authority.updateId,
                runId:snapshot.run.runId,runPhase:snapshot.run.phase,lastError:snapshot.lastError}});return;
          }
          const receipt=await lifecycle.activateExternalRuntimeUpdate(authority);
          if(closing)throw new Error('宿主已停止');
          if(receipt.outcome!=='resumed'||receipt.error||!receipt.snapshot.supervision.owner||receipt.snapshot.mode.kind!=='normal'
            ||receipt.snapshot.run.runId||receipt.snapshot.run.phase!=='stopped')throw new Error('激活收据未证明当前监督所有权与业务静默');
          sendPrivate({kind:'update-host-activated',requestId,allocationId:updateProcess!.allocationId,pid:process.pid,artifactId:updateProcess!.artifact.artifactId,outcome:receipt.outcome});
        }catch(error){sendPrivate({kind:'update-host-rejected',requestId,error:sanitizeDiagnosticText(error)});}
      }).catch(error=>{void shutdown(error);});
    });
    process.once('disconnect', () => { if (!closing) void shutdown(new Error('外部宿主控制连接已断开')); });
  }
  process.on('uncaughtException', error => { void shutdown(error); });
  process.on('unhandledRejection', error => { void shutdown(error); });
  try {
    if(args.has('--host-allocation')) {
      await assertRuntimeDataOutside(appRoot,dataRoot);
      updateStore=new AdminManagementStore(join(dataRoot,'admin-management.db'));
      normalProcess=updateStore.runtimeHostProcesses().find(row=>row.allocationId===args.get('--host-allocation'));
      if(!normalProcess||normalProcess.parentPid!==process.ppid||resolve(normalProcess.artifact.root)!==appRoot)throw new Error('普通宿主实际父进程或安装目录与分配不匹配');
      const assertNormal=()=>{
        if(!process.connected||process.ppid!==normalProcess!.parentPid)throw new Error('普通宿主私有父进程连接已失效');
        updateStore!.assertRuntimeHost(normalProcess!.authority);
        if(updateStore!.activeRuntimeUpdate()||JSON.stringify(updateStore!.runtimeInstallation()?.artifact)!==JSON.stringify(normalProcess!.artifact))throw new Error('普通宿主安装选择或更新门禁已变化');
      };
      assertNormal();updateStore.bindRuntimeHostProcess(normalProcess,process.pid);
      normalFence=setInterval(()=>{try{assertNormal();}catch(error){void shutdown(error);}},1000);normalFence.unref();
      const relaxedWindows=process.env.LOOP_RUNTIME_SAFETY==='standard'&&process.platform==='win32';
      const identity=relaxedWindows?null:
        await (await import('../../src/infrastructure/process-tree')).waitForProcessIdentity(process.pid,{timeoutMs:5000});
      const marker=identity?.startMarker??(relaxedWindows?`unverified:${process.pid}`:undefined);
      if(!marker)throw new Error('普通宿主无法确认真实进程身份');
      updateStore.bindRuntimeHostProcess(normalProcess,process.pid,marker);
      if(process.env.LOOP_RUNTIME_SAFETY!=='standard'){
        const actual=await readHarnessArtifact(appRoot,{assertCurrent:assertNormal});
        if(JSON.stringify(actual)!==JSON.stringify(normalProcess.artifact))throw new Error('普通宿主实际安装字节与分配不符');
      }
      assertNormal();
      updateStore.certifyRuntimeCliHost(normalProcess);
      process.env.LOOP_RUNTIME_HOST_ALLOCATION=normalProcess.allocationId;
    }
    if(args.has('--external-update')) {
      updateStore=new AdminManagementStore(join(dataRoot,'admin-management.db'));
      updateProcess=updateStore.runtimeUpdateProcesses(args.get('--external-update')!).find(row=>row.allocationId===args.get('--allocation-id'));
      if(!updateProcess||updateProcess.parentPid!==process.ppid||resolve(updateProcess.artifact.root)!==appRoot)throw new Error('外部更新实际父进程或安装目录与分配不匹配');
      updateStore.assertRuntimeUpdate(updateProcess.authority);
      // The child also binds before expensive imports/identity validation,
      // reducing the parent-death gap. Unknown reservations are never guessed.
      updateStore.bindRuntimeUpdateProcess(updateProcess,process.pid);
      const {waitForProcessIdentity}=await import('../../src/infrastructure/process-tree');
      const ownIdentity=await waitForProcessIdentity(process.pid,{timeoutMs:5000});
      if(!ownIdentity)throw new Error('无法确认持有式宿主真实进程身份');
      updateStore.bindRuntimeUpdateProcess(updateProcess,process.pid,ownIdentity.startMarker);
      const actual=await readHarnessArtifact(appRoot,{assertCurrent:()=>updateStore!.assertRuntimeUpdate(updateProcess!.authority)});
      if(JSON.stringify(actual)!==JSON.stringify(updateProcess.artifact))throw new Error('实际候选安装字节与持有分配不匹配');
    }
    if (args.has('--watch-parent')) {
      const parent = Number(args.get('--watch-parent'));
      const { inspectProcessIdentity } = await import('../../src/infrastructure/process-tree');
      parentWatch = createHostParentWatch({
        isAvailable: () => { try { process.kill(parent,0); return true; } catch { return false; } },
        readIdentity: async () => (await inspectProcessIdentity(parent))?.startMarker || null,
        onLost: error => shutdown(error),
      });
      await parentWatch.start();
    }
    const pkg = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as { version?: string };
    if (!pkg.version) throw new Error('独立宿主无法定位实际运行版本');
    const { createManagedLoopRunLifecycle } = await import('../../src/infrastructure/runtime-supervision');
    if (closing) return;
    lifecycle = createManagedLoopRunLifecycle({ ownerId: `hosted-${process.pid}-${randomUUID()}`, adapter: 'cli', installedVersion: pkg.version });
    await lifecycle.start();
    if (!closing) {
      log('host-initialized', { appRoot, dataRoot, version: pkg.version, businessSuccess: 'not-asserted' });
      if(normalProcess) {
        let snapshot=await lifecycle.status();const deadline=Date.now()+35_000;
        while(!snapshot.supervision.owner&&!closing&&Date.now()<deadline) {
          updateStore!.assertRuntimeHost(normalProcess.authority);
          await new Promise<void>(resolve=>setTimeout(resolve,250));snapshot=await lifecycle.status();
        }
        if(snapshot.supervision.owner&&snapshot.supervision.token)updateStore!.bindRuntimeBusinessSupervision(normalProcess,snapshot.supervision.token);
        if(closing||!snapshot.supervision.owner||snapshot.lastError)throw new Error('普通宿主未取得健康监督所有权');
        updateStore!.assertRuntimeHost(normalProcess.authority);
        sendPrivate({kind:'normal-host-ready',allocationId:normalProcess.allocationId,pid:process.pid,artifactId:normalProcess.artifact.artifactId,
          businessSupervisionToken:snapshot.supervision.token});
      }
      if(updateProcess) {
        // A degraded initializer may report rather than throw. Read actual
        // lifecycle state, not only host-initialized, before claiming readiness.
        let snapshot=await lifecycle.status();const deadline=Date.now()+35_000;
        while(!snapshot.supervision.owner&&!closing&&Date.now()<deadline) {
          updateStore!.assertRuntimeUpdate(updateProcess.authority);
          await new Promise<void>(resolve=>setTimeout(resolve,250));snapshot=await lifecycle.status();
        }
        if(closing||!snapshot.supervision.owner||snapshot.lastError||snapshot.run.runId||snapshot.run.phase!=='stopped')throw new Error('持有式候选未取得健康监督所有权或未保持业务静默');
        updateStore!.assertRuntimeUpdate(updateProcess.authority);
        sendPrivate({kind:'update-host-ready',allocationId:updateProcess.allocationId,pid:process.pid,artifactId:updateProcess.artifact.artifactId,healthProtocol:'private-health-v1'});
      }
    }
  } catch (error) { await shutdown(error); }
}

void main().catch(error => { process.stderr.write(`${sanitizeDiagnosticText(error instanceof Error ? error.stack : error)}\n`); process.exitCode = 1; });
