/** Publish the independent service before waiting for startup. User/system
 * shutdown during startup can then cancel the real host, not an empty pointer.
 * The installed runtime starts directly; no old-runtime handoff loop delays
 * the desktop UI. */
export async function createDesktopRuntimeHost(ports){
  const service=await ports.createService();
  let ready;
  const host={service,ui:service.ui,status:service.lifecycle.status,reconcile:service.reconcile,shutdown:service.shutdown,
    get ready(){return ready;},
    command:async input=>{const receipt=await service.lifecycle.command(input);
      try{ports.setStartup?.(receipt.snapshot.intent.desired);}catch{receipt.warning='自动启动设置未能保存，运行控制已按回执处理。';}return receipt;}};
  ports.onCreated(host);
  if(ports.isQuitting()){await service.shutdown();return host;}
  ready=Promise.resolve().then(()=>service.start());
  const report=state=>{if(state!=='hosting')ports.onError?.(new Error(`安装包 runtime 启动未完成：${state}`));};
  if(ports.deferStartup)void ready.then(report,error=>ports.onError?.(error));
  else report(await ready);
  if(!ports.isQuitting())try{ports.setStartup?.(service.store.control().desired_intent);}catch(error){ports.onError?.(error);}
  return host;
}

/** Compatibility helper for callers outside the desktop shell. The updater no
 * longer waits for cross-runtime handoff receipts. */
export async function prepareDesktopRuntimeInstall(ports){
  await ports.stopUi().catch(()=>undefined);
  await ports.lifecycle.shutdown().catch(()=>undefined);
}
