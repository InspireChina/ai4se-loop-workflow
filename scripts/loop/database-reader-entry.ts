import {mkdir,readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {projectDatabase,type DatabaseProjection} from '../../src/infrastructure/database-compatibility-projection';
import {sanitizeDiagnosticText} from '../../src/infrastructure/diagnostic-text';
import {assertRuntimeDataOutside} from '../../src/infrastructure/runtime-paths';
import {waitForWindowsJobAdmission} from '../../src/infrastructure/windows-job-containment';
import {atomicReplaceFileSync} from '../../src/infrastructure/atomic-file';

async function main() {
  await waitForWindowsJobAdmission();
  const raw=process.argv.slice(2);const args=new Map<string,string>();
  for(let index=0;index<raw.length;index+=2) {
    const key=raw[index],value=raw[index+1];
    if(!['--app-root','--data-root','--original','--allocation'].includes(key)||!value||!isAbsolute(value)||args.has(key)||/[\x00-\x1f]/.test(value))throw new Error('无效数据库副本读者参数');
    args.set(key,value);
  }
  if(!args.has('--app-root')||!args.has('--data-root')||!args.has('--allocation')||!process.send||!process.connected)throw new Error('数据库读者必须由私有通道启动');
  const appRoot=resolve(args.get('--app-root')!),dataRoot=resolve(args.get('--data-root')!);
  await assertRuntimeDataOutside(appRoot,dataRoot);
  const allocationPath=args.get('--allocation')!;const allocation=JSON.parse(readFileSync(allocationPath,'utf8'));
  if(allocation.parentPid!==process.ppid||resolve(allocation.appRoot)!==appRoot||allocation.pid&&allocation.pid!==process.pid)throw new Error('数据库读者父进程或分配不匹配');
  // Self-binding before DB imports also preserves a parent-death launch gap.
  atomicReplaceFileSync(allocationPath,JSON.stringify({...allocation,pid:process.pid,groupId:process.platform!=='win32'?process.pid:null}));
  const {waitForProcessIdentity}=await import('../../src/infrastructure/process-tree');
  const identity=await waitForProcessIdentity(process.pid,{timeoutMs:5000});
  if(!identity)throw new Error('数据库读者启动身份无法确认');
  atomicReplaceFileSync(allocationPath,JSON.stringify({...JSON.parse(readFileSync(allocationPath,'utf8')),marker:identity.startMarker}));
  let completed=false;process.once('disconnect',()=>{if(!completed)process.exit(1);});
  // Never discover/import a real configured workspace or a legacy DB.
  const workspace=join(dataRoot,'probe-workspace');await mkdir(workspace,{recursive:true});await mkdir(join(dataRoot,'tmp'),{recursive:true});
  process.env.LOOP_APP_ROOT=appRoot;process.env.LOOP_DATA_ROOT=dataRoot;
  process.env.LOOP_GLOBAL_DB_PATH=join(dataRoot,'loop-ui.db');
  process.env.LOOP_WORKSPACE_ROOT_OVERRIDE=workspace;process.env.LOOP_WORKSPACE_ROOT=workspace;
  process.env.LOOP_LEGACY_DB_PATH=join(dataRoot,'nonexistent-legacy.db');process.env.SQLITE_TMPDIR=join(dataRoot,'tmp');
  const original=args.has('--original')?JSON.parse(await readFile(args.get('--original')!,'utf8')) as {application:DatabaseProjection;business:DatabaseProjection}:undefined;
  const {appDatabaseConnection,databaseConnection}=await import('../../src/infrastructure/database');
  const application=appDatabaseConnection();const business=await databaseConnection();
  try {
    for(const database of [application,business]) {
      const checks=database.pragma('quick_check') as {quick_check:string}[];
      if(checks.length!==1||checks[0].quick_check!=='ok')throw new Error('数据库副本完整性检查失败');
      if((database.pragma('foreign_key_check') as unknown[]).length)throw new Error('数据库副本外键检查失败');
    }
    const result={application:projectDatabase(application,original?.application),business:projectDatabase(business,original?.business)};
    await new Promise<void>((resolve,reject)=>process.send!({kind:'database-reader-result',result},error=>error?reject(error):resolve()));
  }finally {business.close();application.close();completed=true;if(process.connected)process.disconnect();}
}
void main().catch(error=>{process.stderr.write(`${sanitizeDiagnosticText(error instanceof Error?error.stack:error)}\n`);process.exitCode=1;if(process.connected)process.disconnect();});
