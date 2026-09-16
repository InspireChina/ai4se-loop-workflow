import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {AdminManagementStore} from '../../src/infrastructure/admin-management-store';
import {inspectProcessIdentity} from '../../src/infrastructure/process-tree';
import {readHarnessArtifact} from '../harness-artifact.mjs';
import {createHostParentWatch} from '../../src/application/host-parent-watch';
import {sanitizeDiagnosticText} from '../../src/infrastructure/diagnostic-text';
import {waitForWindowsJobAdmission} from '../../src/infrastructure/windows-job-containment';

/** Stable root helper verifies ownership BEFORE loading selected Next code.
 * Losing the parent never promotes this UI process into a business host. */
async function main(){
  await waitForWindowsJobAdmission();
  if(!process.connected||!process.send)throw new Error('界面服务必须由独立 root 私有启动');
  const raw=process.argv.slice(2),args=new Map<string,string>();
  for(let index=0;index<raw.length;index+=2){const key=raw[index],value=raw[index+1];
    if(!['--app-root','--data-root','--ui-allocation'].includes(key)||!value||args.has(key))throw new Error('界面服务参数无效');args.set(key,value);}
  const appRoot=args.get('--app-root'),dataRoot=args.get('--data-root'),allocationId=args.get('--ui-allocation');
  if(!appRoot||!dataRoot||!isAbsolute(appRoot)||!isAbsolute(dataRoot)||/[\x00-\x1f]/.test(appRoot+dataRoot)
    ||!allocationId||!/^[a-f0-9-]{36}$/.test(allocationId))throw new Error('界面服务必须绑定实际路径和分配');
  const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));let watch:ReturnType<typeof createHostParentWatch>|undefined;
  let fence:NodeJS.Timeout|undefined;let closing=false;
  const shutdown=async(error?:unknown)=>{if(closing)return;closing=true;watch?.stop();if(fence)clearInterval(fence);
    try{if(error)process.stderr.write(sanitizeDiagnosticText(error instanceof Error?error.stack||error.message:String(error))+'\n');}catch{/* exit wins */}
    store.close();if(process.connected)process.disconnect();process.exit(error?1:0);};
  process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
  process.once('disconnect',()=>{void shutdown(new Error('界面服务实际私有父宿主失效'));});
  process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
  process.on('uncaughtException',error=>{void shutdown(error);});process.on('unhandledRejection',error=>{void shutdown(error);});
  try{
    const deadline=Date.now()+10000;
    let record=store.runtimeUiProcesses().find(row=>row.allocationId===allocationId);
    while(record&&!record.marker&&Date.now()<deadline){store.assertRuntimeHost(record.authority);
      await new Promise(resolve=>setTimeout(resolve,50));record=store.runtimeUiProcesses().find(row=>row.allocationId===allocationId);}
    if(!record||record.pid!==process.pid||record.parentPid!==process.ppid||!record.marker||record.status==='exited')throw new Error('界面服务实际父子身份未登记');
    const source=record;
    const guard=()=>{store.assertRuntimeHost(source.authority);const current=store.runtimeUiProcesses().find(row=>row.allocationId===allocationId);
      if(!process.connected||!current||current.status==='exited'||current.pid!==source.pid||current.marker!==source.marker||current.parentPid!==process.ppid
        ||JSON.stringify(current.authority)!==JSON.stringify(source.authority)||JSON.stringify(current.artifact)!==JSON.stringify(source.artifact)
        ||resolve(appRoot)!==resolve(source.artifact.root)||store.control().management_mode!=='normal'||store.activeRuntimeUpdate()
        ||JSON.stringify(store.runtimeInstallation()?.artifact)!==JSON.stringify(source.artifact))throw new Error('界面服务来源、父宿主或更新门禁失效');};
    guard();const actual=await readHarnessArtifact(appRoot,{assertCurrent:guard});guard();
    if(JSON.stringify(actual)!==JSON.stringify(source.artifact)||(await inspectProcessIdentity(process.pid))?.startMarker!==source.marker)throw new Error('界面服务实际产物或 OS 身份不匹配');guard();
    const protocol=JSON.parse(await readFile(join(appRoot,'external-ui-protocol.json'),'utf8'));guard();
    if(protocol.version!==1||protocol.sourceId!==actual.sourceId)throw new Error('所选界面版本不支持独立监督协议');
    watch=createHostParentWatch({isAvailable:()=>{try{process.kill(source.parentPid,0);return true;}catch{return false;}},
      readIdentity:async()=>(await inspectProcessIdentity(source.parentPid))?.startMarker??null,onLost:shutdown});await watch.start();guard();
    fence=setInterval(()=>{try{guard();}catch(error){void shutdown(error);}},1000);fence.unref();
    process.env.LOOP_APP_ROOT=appRoot;process.env.LOOP_DATA_ROOT=dataRoot;process.env.LOOP_GLOBAL_DB_PATH=join(dataRoot,'loop-ui.db');
    process.env.LOOP_DESKTOP='1';process.env.LOOP_EXTERNAL_UI_ALLOCATION=allocationId;
    const require=createRequire(join(appRoot,'package.json'));guard();require(join(appRoot,'server.js'));guard();
    process.send({kind:'ui-server-authorized',allocationId,pid:process.pid,artifactId:actual.artifactId,protocolVersion:1});
  }catch(error){await shutdown(error);}
}
void main().catch(error=>{try{process.stderr.write(sanitizeDiagnosticText(error)+'\n');}finally{process.exit(1);}});
