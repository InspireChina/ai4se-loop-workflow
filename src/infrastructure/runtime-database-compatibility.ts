import Database from 'better-sqlite3';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {lstat,mkdir,mkdtemp,readFile,writeFile,readdir,rename} from 'node:fs/promises';
import {basename,isAbsolute,join,sep,dirname} from 'node:path';
import type {RuntimeArtifact,RuntimeUpdateRecord} from '../domain/runtime-update';
import {runtimeRollbackTarget,RuntimeCompatibilityResample} from '../domain/runtime-update';
import {assertDatabaseProjectionPreserved,type DatabaseProjection} from './database-compatibility-projection';
import {waitForProcessIdentity,terminateProcessGroup,inspectProcessGroup} from './process-tree';
import {sanitizeDiagnosticText} from './diagnostic-text';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {assertRuntimeDataOutside} from './runtime-paths';
import {attachWindowsJobContainment,confirmWindowsJobContainmentExit,withWindowsJobAdmission} from './windows-job-containment';

type Projection={application:DatabaseProjection;business:DatabaseProjection};
type Check=()=>void;
/** SQLite online backup + actual packaged readers. No live DB migrations or
 * snapshot restoration. Refuse unknown applied migration/data transformations
 * rather than waiving old-code compatibility to force an update through. */
export function createRuntimeDatabaseCompatibility(ports:{dataRoot:string;executable:string;electronNode?:boolean;
  timeoutMs?:number;confirmContainmentExit?:(pid:number,marker:string|null)=>Promise<boolean>}) {
  if(!isAbsolute(ports.dataRoot)||!isAbsolute(ports.executable))throw new Error('数据库兼容验证必须使用绝对路径');
  const pendingRoot=join(ports.dataRoot,'runtime-updates','compatibility','pending-readers');
  type Allocation={allocationId:string;updateId:string;ownerId:string|null;token:number;parentPid:number;appRoot:string;pid:number|null;marker:string|null;groupId:number|null;evidenceRoot:string};
  const readAllocation=(path:string)=>{const value=JSON.parse(readFileSync(path,'utf8')) as Allocation;
    return {...value,allocationId:value.allocationId||basename(path,'.json')};};
  const draining=new Map<string,Promise<boolean>>();const completed=new Set<string>();
  async function drainImpl(path:string) {
    const record=readAllocation(path);
    let exited=false;
    if(process.platform==='win32')exited=ports.confirmContainmentExit
      ? record.pid!==null&&!!await ports.confirmContainmentExit(record.pid,record.marker)
      : await confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:{allocationId:record.allocationId,pid:record.pid,marker:record.marker}});
    else if(!record.pid)return false;
    else if(record.groupId) {
      if(record.marker)exited=await terminateProcessGroup(record.groupId,5000,record.marker);
      else {const members=await inspectProcessGroup(record.groupId);exited=!!members&&!members.length;}
    }
    if(!exited)return false;
    await rename(path,join(record.evidenceRoot,`${path.split(sep).at(-1)}.exited`));completed.add(path);return true;
  }
  function drain(path:string):Promise<boolean> {
    if(completed.has(path))return Promise.resolve(true);
    const prior=draining.get(path);if(prior)return prior;
    const result=drainImpl(path).finally(()=>draining.delete(path));draining.set(path,result);return result;
  }
  async function stopOwned(authority?:{updateId:string;ownerId:string;token:number}) {
    const files=await readdir(pendingRoot).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    if(files.length>10000)throw new Error('数据库读者退出屏障超过上限');let complete=true;
    for(const file of files) {
      const path=join(pendingRoot,file);const record=readAllocation(path);
      if(authority&&(record.updateId!==authority.updateId||record.ownerId!==authority.ownerId||record.token!==authority.token))continue;
      if(!await drain(path))complete=false;
    }
    return complete;
  }
  async function reader(artifact:RuntimeArtifact,update:RuntimeUpdateRecord,dataRoot:string,original:string|undefined,signal:AbortSignal,check:Check):Promise<Projection> {
    check();if(signal.aborted)throw new Error('数据库兼容验证已取消');
    if(JSON.stringify(await readHarnessArtifact(artifact.root,{signal,assertCurrent:check}))!==JSON.stringify(artifact))throw new Error('数据库读者实际安装身份不匹配');check();
    await mkdir(pendingRoot,{recursive:true,mode:0o700});check();
    const allocationId=randomUUID();const allocationPath=join(pendingRoot,`${allocationId}.json`);
    const allocation:Allocation={allocationId,updateId:update.request.updateId,ownerId:update.ownerId,token:update.token,parentPid:process.pid,
      appRoot:artifact.root,pid:null,marker:null,groupId:null,evidenceRoot:dirname(dataRoot)};
    writeFileSync(allocationPath,JSON.stringify(allocation),{flag:'wx',mode:0o600});
    let env:NodeJS.ProcessEnv={...process.env,NODE_OPTIONS:'',NODE_PATH:''};
    for(const key of Object.keys(env))if(key.startsWith('LOOP_')||key==='NODE_TEST_CONTEXT')delete env[key];
    if(ports.electronNode)env.ELECTRON_RUN_AS_NODE='1';else delete env.ELECTRON_RUN_AS_NODE;
    env=withWindowsJobAdmission(env,ports.dataRoot,allocationId);
    const child=spawn(ports.executable,[join(artifact.root,'desktop-runners','database-reader.cjs'),'--app-root',artifact.root,
      '--data-root',dataRoot,'--allocation',allocationPath,...(original?['--original',original]:[])],{cwd:artifact.root,env,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    if(child.pid)writeFileSync(allocationPath,JSON.stringify({...allocation,pid:child.pid,groupId:process.platform!=='win32'?child.pid:null}),{mode:0o600});
    let stderr='',result:Projection|undefined,marker:string|null=null,spawnError:Error|undefined;
    child.stdout!.on('data',()=>undefined);child.stderr!.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-64000);});
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    child.once('error',error=>{spawnError=error;});
    child.on('message',message=>{if(message&&typeof message==='object'&&'kind'in message&&message.kind==='database-reader-result'&&'result'in message)result=message.result as Projection;});
    let timer:NodeJS.Timeout|undefined;let fence:NodeJS.Timeout|undefined;
    let rejectInterrupted!:(error:Error)=>void;const interrupted=new Promise<never>((_,reject)=>{rejectInterrupted=reject;});void interrupted.catch(()=>undefined);
    const abort=()=>rejectInterrupted(new Error('数据库兼容验证已取消'));
    signal.addEventListener('abort',abort,{once:true});
    const exit=async()=>{
      if(!child.pid){await closed;if(!spawnError)return false;await rename(allocationPath,join(allocation.evidenceRoot,`${randomUUID()}.no-spawn.exited`));completed.add(allocationPath);return true;}
      return drain(allocationPath);
    };
    try {
      timer=setTimeout(()=>rejectInterrupted(new Error('数据库兼容读者超时')),ports.timeoutMs??120000);
      fence=setInterval(()=>{try{check();}catch(error){rejectInterrupted(error instanceof Error?error:new Error(String(error)));}},250);
      if(signal.aborted)abort();
      if(child.pid) {
        if(!await attachWindowsJobContainment({dataRoot:ports.dataRoot,allocationId,pid:child.pid}))
          throw new Error('数据库兼容读者无法进入 Windows Job 容器');
        marker=(await waitForProcessIdentity(child.pid,{timeoutMs:5000}))?.startMarker||null;
        if(marker)writeFileSync(allocationPath,JSON.stringify({...readAllocation(allocationPath),marker}),{mode:0o600});
      }
      await Promise.race([closed,interrupted]);check();
      if(spawnError)throw spawnError;
      if(child.exitCode!==0||!result)throw new Error(`数据库版本读者失败：${sanitizeDiagnosticText(stderr)}`);
      if(JSON.stringify(await readHarnessArtifact(artifact.root,{signal,assertCurrent:check}))!==JSON.stringify(artifact))throw new Error('数据库读者执行期间安装身份变化');check();
      return result;
    }finally {
      if(timer)clearTimeout(timer);if(fence)clearInterval(fence);signal.removeEventListener('abort',abort);
      if(!await exit())throw new Error('数据库读者退出屏障保留，不能激活版本');
    }
  }
  const validate=async function validate(artifact:RuntimeArtifact,update:RuntimeUpdateRecord,signal:AbortSignal,assertCurrent:Check) {
    const check=()=>{assertCurrent();if(signal.aborted)throw new Error('数据库兼容验证已取消');};check();
    const rollbackArtifact=runtimeRollbackTarget(update);
    if(!await stopOwned())throw new Error('旧数据库读者退出未确认，拒绝再次启动或激活');check();
    for(const root of [update.request.before.root,rollbackArtifact.root,update.request.candidate.root]) {
      await assertRuntimeDataOutside(root,ports.dataRoot);check();
    }
    const directory=join(ports.dataRoot,'runtime-updates','compatibility');await mkdir(directory,{recursive:true,mode:0o700});check();
    const evidenceRoot=await mkdtemp(join(directory,'probe-'));const copy=join(evidenceRoot,'databases');await mkdir(copy,{mode:0o700});
    const sources:{name:string;db:Database.Database;version:number;ino:number;dev:number}[]=[];
    const absent:string[]=[];
    try {
      for(const name of ['loopwork.db','loop-ui.db']) {
        check();const source=join(ports.dataRoot,name);const stat=await lstat(source).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(!stat){absent.push(name);continue;}if(!stat.isFile()||stat.nlink!==1)throw new Error('数据库备份源不是普通独立文件');
        const db=new Database(source,{readonly:true,fileMustExist:true});const version=db.pragma('data_version',{simple:true}) as number;
        sources.push({name,db,version,ino:stat.ino,dev:stat.dev});
        await db.backup(join(copy,name),{progress:()=>{check();return 50;}});check();
      }
      const before=await reader(rollbackArtifact,update,copy,undefined,signal,check);
      const original=join(evidenceRoot,'original-projection.json');await writeFile(original,JSON.stringify(before),{flag:'wx',mode:0o600});
      let after=before;
      if(artifact.artifactId===update.request.candidate.artifactId) {
        for(const [folder,kind] of [['app-migrations','application'],['migrations','business']] as const) {
          for(const name of before[kind].migrations) {
            // Retired histories may have no SQL file in either source tree.
            const nextBytes=await readFile(join(artifact.root,folder,name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
            // A historical reader is not permission to discard the original
            // installation's executed-SQL constraint after entrypoint damage.
            for(const root of new Set([rollbackArtifact.root,update.request.before.root])) {
              const oldBytes=await readFile(join(root,folder,name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
              if(oldBytes&&(!nextBytes||!oldBytes.equals(nextBytes)))throw new Error(`候选改变已执行迁移：${folder}/${name}`);
            }
          }
        }
        after=await reader(artifact,update,copy,original,signal,check);
        assertDatabaseProjectionPreserved(before.application,after.application);assertDatabaseProjectionPreserved(before.business,after.business);
        const rollback=await reader(rollbackArtifact,update,copy,original,signal,check);
        assertDatabaseProjectionPreserved(before.application,rollback.application);assertDatabaseProjectionPreserved(before.business,rollback.business);
      }
      for(const source of sources) {
        check();const stat=await lstat(join(ports.dataRoot,source.name));
        if(source.db.pragma('data_version',{simple:true})!==source.version||stat.ino!==source.ino||stat.dev!==source.dev)throw new RuntimeCompatibilityResample('兼容验证期间真实数据改变，必须重新获取副本');
      }
      for(const name of absent)if(await lstat(join(ports.dataRoot,name)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw new RuntimeCompatibilityResample('兼容验证期间出现新数据库，必须重新检查');
      check();const evidence={schema:1,updateId:update.request.updateId,phase:update.phase,artifact,originalInstallation:update.request.before,rollbackArtifact,rollbackSourceUpdateId:update.rollback?.sourceUpdateId || null,before,after,
        sources:sources.map(source=>({name:source.name,dataVersion:source.version})),absent,
        policy:'expand-only, original data preserved, same-name executed SQL immutable; actual known-good reader must reopen upgraded copy',
        passed:true};
      await writeFile(join(evidenceRoot,'receipt.json'),JSON.stringify({...evidence,evidenceHash:createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}),{flag:'wx',mode:0o600});check();
    }finally {for(const source of sources)source.db.close();}
  };
  let active:Promise<void>|undefined;
  const exclusive=(artifact:RuntimeArtifact,update:RuntimeUpdateRecord,signal:AbortSignal,check:Check)=>{
    if(active)return Promise.reject(new Error('数据库兼容验证已有活动读者，拒绝并发重复启动'));
    active=validate(artifact,update,signal,check).finally(()=>{active=undefined;});return active;
  };
  return Object.assign(exclusive,{stopOwned});
}
