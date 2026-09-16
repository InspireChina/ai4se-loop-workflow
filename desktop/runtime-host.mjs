const transientStartupState=state=>state==='observer'||state==='updating';

async function settleStartup(service,ports,state){
  const now=ports.now??Date.now;
  const timeoutMs=ports.startupHandoffTimeoutMs??45_000;
  const deadline=now()+timeoutMs;
  while(transientStartupState(state)&&!ports.isQuitting()&&now()<deadline){
    if(ports.waitBeforeRetry)await ports.waitBeforeRetry();
    else await new Promise(resolve=>setTimeout(resolve,250));
    if(ports.isQuitting())break;
    state=await service.reconcile();
  }
  return state;
}

/** Publish the independent service before waiting for startup. User/system
 * shutdown during startup can then cancel the real host, not an empty pointer.
 * A previous updater process may retain its lease briefly; observer/update
 * states are handoff progress, not permission to start the desktop UI. */
export async function createDesktopRuntimeHost(ports){
  const service=await ports.createService();
  const host={service,ui:service.ui,status:service.lifecycle.status,reconcile:service.reconcile,shutdown:service.shutdown,
    command:async input=>{const receipt=await service.lifecycle.command(input);
      try{ports.setStartup?.(receipt.snapshot.intent.desired);}catch{receipt.warning='自动启动设置未能保存，运行控制已按回执处理。';}return receipt;}};
  ports.onCreated(host);
  if(ports.isQuitting()){await service.shutdown();return host;}
  const state=await settleStartup(service,ports,await service.start());
  if(transientStartupState(state))ports.onError?.(new Error(`桌面外部 root 交接尚未完成：${state}`));
  if(!ports.isQuitting())try{ports.setStartup?.(service.store.control().desired_intent);}catch(error){ports.onError?.(error);}
  return host;
}

/** A ready-for-update receipt covers managed children, not the Electron root
 * itself. Release that final lease before handing control to the installer. */
export async function prepareDesktopRuntimeInstall(ports){
  await ports.stopUi();
  await ports.lifecycle.service.assertUpdateReady();
  await ports.lifecycle.shutdown();
}
