import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import type {AdminAuthority} from '../domain/repair-case';
import type {RuntimeHostAuthority} from '../domain/runtime-update';
import {runtimeBusinessBaselineSchema} from '../domain/runtime-business-progress';
import type {AdminManagementStore} from './admin-management-store';
import {captureRuntimeBusinessBaselineInDb} from '../application/runtime-business-progress';
import {assertRuntimeVerificationInput} from './runtime-verification-input';
import {inspectProcessGroup} from './process-tree';
import {confirmWindowsJobContainmentExit} from './windows-job-containment';

/** Runs only inside the stable Root's fenced capability child. No business
 * bootstrap, migration, configured workspace or writable business handle. */
export async function freezeRuntimeBusinessBaseline(ports:{
  store:AdminManagementStore;root:RuntimeHostAuthority;management:AdminAuthority;
  updateId:string;dataRoot:string;assertCurrent:()=>void;signal?:AbortSignal;
}) {
  const target=ports.store.runtimeBusinessBaselineTarget(ports.root,ports.management,ports.updateId);
  if(!target)return null;
  const check=()=>{
    ports.signal?.throwIfAborted();ports.assertCurrent();
    const current=ports.store.runtimeBusinessBaselineTarget(ports.root,ports.management,ports.updateId);
    if(!current||JSON.stringify(current)!==JSON.stringify(target))throw new Error('原业务基线读取的实际来源已改变');
  };
  check();
  await assertRuntimeVerificationInput(target.input,{store:ports.store,caseId:target.binding.caseId,
    dataRoot:ports.dataRoot,signal:ports.signal,assertCurrent:check});check();
  for(const record of [...target.predecessors,...target.clis]){
    if(!record.pid||!record.marker)throw new Error('原业务基线缺少旧进程实际身份');
    const exited=process.platform==='win32'
      ? await confirmWindowsJobContainmentExit({dataRoot:ports.dataRoot,process:record})
      : !!record.groupId&&await inspectProcessGroup(record.groupId).then(members=>!!members&&!members.length);
    check();if(!exited)throw new Error('旧宿主/CLI 容器实际存活或无法核对，禁止冻结原业务基线');
  }
  const saved=ports.store.runtimeBusinessBaseline(target.binding.verificationAttemptId);
  if(saved){check();return saved;} // Crash after commit never takes a new snapshot.
  const filename=join(ports.dataRoot,'loop-ui.db');
  let exists=true;
  try{
    const file=await lstat(filename);check();
    if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1)throw new Error('原业务数据库必须是独立实际文件');
  }catch(error){
    check();if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;exists=false;
  }
  if(!exists){
    check();return ports.store.recordRuntimeBusinessBaseline(ports.root,ports.management,ports.updateId,
      runtimeBusinessBaselineSchema.parse({...target.binding,schemaVersion:1,businessStore:'absent',tasks:[]}));
  }
  check();const db=new Database(filename,{readonly:true,fileMustExist:true});
  try{
    const baseline=captureRuntimeBusinessBaselineInDb(db,{...target.binding,assertQuiescent:check});
    check();return ports.store.recordRuntimeBusinessBaseline(ports.root,ports.management,ports.updateId,baseline);
  }finally{db.close();}
}
