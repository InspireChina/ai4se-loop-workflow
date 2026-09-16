import {isAbsolute,join,resolve} from 'node:path';
import {AdminManagementStore} from '../../src/infrastructure/admin-management-store';
import {adminBusinessRequestSchema} from '../../src/domain/admin-business-worker';
import {readHarnessArtifact} from '../harness-artifact.mjs';
import {sanitizeDiagnosticText} from '../../src/infrastructure/diagnostic-text';
import {waitForWindowsJobAdmission} from '../../src/infrastructure/windows-job-containment';

/** Only private parent IPC can request one trusted capability. Root/databases
 * and actual allocation are validated before importing business modules. */
async function main(){
  await waitForWindowsJobAdmission();
  if(!process.connected||!process.send)throw new Error('业务能力 worker 必须由独立外部 root 私有启动');
  const raw=process.argv.slice(2);const args=new Map<string,string>();
  for(let index=0;index<raw.length;index+=2){
    const key=raw[index],value=raw[index+1];
    if(!['--data-root','--allocation-id'].includes(key)||!value||args.has(key))throw new Error('无效业务能力 worker 参数');args.set(key,value);
  }
  const dataRoot=args.get('--data-root'),allocationId=args.get('--allocation-id');
  if(!dataRoot||!isAbsolute(dataRoot)||/[\x00-\x1f]/.test(dataRoot)||!allocationId||!/^[a-f0-9-]{36}$/.test(allocationId))throw new Error('业务能力 worker 必须绑定独立数据路径与分配');
  const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));
  let busy=false;let closed=false;
  const close=()=>{if(!closed){closed=true;store.close();}};
  const finish=()=>{close();if(process.connected)process.disconnect();};
  try{
  const record=store.adminBusinessWorker(allocationId);
  if(!record||record.parentPid!==process.ppid||record.pid!==process.pid)throw new Error('业务能力 worker 的实际父子身份不匹配');
  const guard=()=>{const current=store.adminBusinessWorker(allocationId);if(!current||current.parentPid!==process.ppid||current.pid!==process.pid||!process.connected)throw new Error('业务能力 worker 私有父宿主已失效');store.assertAdminBusinessWorker(current);};
  guard();
  if(JSON.stringify(await readHarnessArtifact(record.artifact.root))!==JSON.stringify(record.artifact))throw new Error('业务能力 worker 实际安装不匹配');
  guard();
  process.env.LOOP_APP_ROOT=record.artifact.root;process.env.LOOP_DATA_ROOT=resolve(dataRoot);process.env.LOOP_GLOBAL_DB_PATH=join(dataRoot,'loop-ui.db');
  process.once('disconnect',()=>{if(!busy)close();else process.exit(1);});
  process.send({kind:'ready',allocationId,pid:process.pid});
  process.once('message',input=>{void(async()=>{
    busy=true;let value:unknown;let error:string|undefined;
    try{
      guard();const message=input as {kind?:string;allocationId?:string;request?:unknown};
      if(message?.kind!=='perform'||message.allocationId!==allocationId)throw new Error('未授权的私有业务能力请求');
      const request=adminBusinessRequestSchema.parse(message.request);
      if(request.operation!==record.operation)throw new Error('业务能力请求与原分配用途不一致');
      if(request.operation==='harness-actions'){
        const {prepareAdminHarnessWorkspaces}=await import('../../src/infrastructure/admin-harness-workspaces');guard();
        value=await prepareAdminHarnessWorkspaces({store,authority:record.managementAuthority,dataRoot,assertCurrent:guard});
      }else if(request.operation==='harness-build'){
        const {buildAdminHarnessCandidates}=await import('../../src/infrastructure/admin-harness-build');guard();
        value=await buildAdminHarnessCandidates({store,authority:record.managementAuthority,dataRoot,assertCurrent:guard});
      }else if(request.operation==='runtime-business-baseline'){
        const {freezeRuntimeBusinessBaseline}=await import('../../src/infrastructure/runtime-business-baseline');guard();
        value=await freezeRuntimeBusinessBaseline({store,root:record.rootAuthority,management:record.managementAuthority,
          updateId:request.updateId,dataRoot,assertCurrent:guard,signal:AbortSignal.timeout(60000)});
      }else if(request.operation==='runtime-business-progress'){
        const {observeRuntimeBusinessProgress}=await import('../../src/infrastructure/runtime-business-progress');guard();
        value=await observeRuntimeBusinessProgress({store,authority:record.managementAuthority,caseId:request.caseId,
          dataRoot,assertCurrent:guard,signal:AbortSignal.timeout(60000)});
      }else if(request.operation==='assert-runtime'){
        const {independentPreparationHash}=await import('../../src/domain/independent-verification-preparation');
        const {assertRuntimeVerificationInput}=await import('../../src/infrastructure/runtime-verification-input');guard();
        const claim=store.currentIndependentVerificationClaim(record.managementAuthority,request.caseId);
        const source=store.independentVerificationInput(claim);
        if(source.kind!=='runtime'||independentPreparationHash(source)!==request.inputHash)throw new Error('runtime 独立验收来源指纹已变化');
        await assertRuntimeVerificationInput(source,{store,caseId:request.caseId,dataRoot,assertCurrent:()=>{guard();store.assertIndependentVerificationClaim(claim);}});value=true;
      }else{
      const {createAdminBusinessOperations}=await import('../../src/infrastructure/admin-business-operations');guard();
      value=await createAdminBusinessOperations({store,authority:record.managementAuthority,appRoot:record.artifact.root,assertCurrent:guard})(request);
      }
    }catch(reason){error=sanitizeDiagnosticText(reason instanceof Error?reason.stack||reason.message:String(reason),16000);}
    if(process.connected)process.send!({kind:'result',allocationId,pid:process.pid,ok:!error,value:value??null,error},()=>{busy=false;finish();});
    else{busy=false;finish();}
  })().catch(error=>{console.error(sanitizeDiagnosticText(String(error)));process.exitCode=1;busy=false;finish();});});
  }catch(error){finish();throw error;}
}
void main().catch(error=>{console.error(sanitizeDiagnosticText(error instanceof Error?error.stack||error.message:String(error)));process.exitCode=1;if(process.connected)process.disconnect();});
