import {isAbsolute,join,resolve} from 'node:path';
import {appendFile,mkdir} from 'node:fs/promises';
import {createNativeExternalService} from '../../src/infrastructure/native-external-service';
import {createHostParentWatch} from '../../src/application/host-parent-watch';
import {inspectProcessIdentity} from '../../src/infrastructure/process-tree';
import {sanitizeDiagnosticText} from '../../src/infrastructure/diagnostic-text';

/** Stable OS-facing root. It never delegates its management lifetime to the
 * selected business bundle, starts Web, or overrides saved business intent. */
async function main(){
  const args=new Map<string,string>();const raw=process.argv.slice(2);
  for(let index=0;index<raw.length;index+=2){
    const key=raw[index],value=raw[index+1];
    if(!['--app-root','--management-root','--data-root','--electron-node','--watch-parent'].includes(key)||!value||args.has(key))throw new Error('外部 root 参数无效');
    if(key==='--watch-parent'){if(!/^[1-9]\d*$/.test(value)||Number(value)!==process.ppid)throw new Error('外部 root 必须绑定实际父进程');}
    else if(!isAbsolute(value)||/[\x00-\x1f]/.test(value))throw new Error('外部 root 路径必须是绝对路径');
    args.set(key,value);
  }
  const appRoot=args.get('--app-root'),dataRoot=args.get('--data-root');
  if(!appRoot||!dataRoot)throw new Error('外部 root 必须显式提供实际安装与独立数据路径');
  if(args.has('--electron-node')&&resolve(args.get('--electron-node')!)!==resolve(process.execPath))throw new Error('Electron Node 必须匹配当前实际可执行文件');
  await mkdir(dataRoot,{recursive:true,mode:0o700});
  const signal=new AbortController();let service:Awaited<ReturnType<typeof createNativeExternalService>>|undefined;
  let closing:Promise<void>|undefined;let parent:ReturnType<typeof createHostParentWatch>|undefined;let writes=Promise.resolve();let queuedWrites=0;
  const log=(kind:string,detail:Record<string,unknown>={})=>{
    const line=JSON.stringify({at:new Date().toISOString(),kind,pid:process.pid,...detail})+'\n';
    try{process.stdout.write(line);}catch{/* physical termination wins over logging */}
    if(queuedWrites>=128)return; // A stuck logger must not grow the root without bound.
    queuedWrites++;
    writes=writes.catch(()=>{}).then(()=>appendFile(join(dataRoot,'external-host.log'),line,{mode:0o600})).catch(()=>{}).finally(()=>{queuedWrites--;});
  };
  process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
  const keepAlive=setInterval(()=>log('external-host-heartbeat'),30_000);
  const shutdown=(failure?:unknown)=>{
    if(closing)return closing;signal.abort(failure);parent?.stop();
    if(failure){process.exitCode=1;log('external-host-fatal',{error:sanitizeDiagnosticText(failure instanceof Error?failure.stack||failure.message:String(failure))});}
    closing=(async()=>{
      const watchdog=setTimeout(()=>{log('external-host-shutdown-timeout');process.exit(1);},30_000);
      try{
        await service?.shutdown();log('external-host-stopped',{preservesIntent:true});clearInterval(keepAlive);if(process.connected)process.disconnect();
        // Physical cleanup completed before flushing diagnostics. Filesystem
        // latency cannot keep an OS root alive indefinitely after shutdown.
        let flushTimer:NodeJS.Timeout|undefined;
        try{await Promise.race([writes,new Promise<void>(resolve=>{flushTimer=setTimeout(resolve,1000);})]);}
        finally{if(flushTimer)clearTimeout(flushTimer);}
        clearTimeout(watchdog);process.exit(Number(process.exitCode)||0);
      }
      catch(error){process.exitCode=1;log('external-host-shutdown-failed',{error:sanitizeDiagnosticText(String(error))});}
    })();return closing;
  };
  process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
  process.on('uncaughtException',error=>{void shutdown(error);});process.on('unhandledRejection',error=>{void shutdown(error);});
  if(process.connected){process.on('message',message=>{if(message&&typeof message==='object'&&'kind'in message&&message.kind==='shutdown-host')void shutdown();});process.once('disconnect',()=>{if(!closing)void shutdown(new Error('外部 root 的私有父进程失效'));});}
  try{
    if(args.has('--watch-parent')){
      const pid=Number(args.get('--watch-parent'));parent=createHostParentWatch({
        isAvailable:()=>{try{process.kill(pid,0);return true;}catch{return false;}},
        readIdentity:async()=>(await inspectProcessIdentity(pid))?.startMarker??null,onLost:reason=>shutdown(reason)});await parent.start();
    }
    service=await createNativeExternalService({appRoot,managementRoot:args.get('--management-root'),dataRoot,executable:process.execPath,electronNode:args.has('--electron-node'),signal:signal.signal,
      onError:error=>log('external-host-error',{error:sanitizeDiagnosticText(error instanceof Error?error.stack||error.message:String(error))})});
    if(closing){await service.shutdown();return;}
    const state=await service.start();if(closing)return;
    log('external-host-initialized',{state,bootstrap:service.bootstrap,businessSuccess:'not-asserted'});
    if(process.connected)process.send?.({kind:'external-host-ready',pid:process.pid,artifactId:service.bootstrap.artifactId,state});
  }catch(error){await shutdown(error);}
}
void main().catch(error=>{console.error(sanitizeDiagnosticText(String(error)));process.exitCode=1;});
