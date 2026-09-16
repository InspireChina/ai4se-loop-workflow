/** Publish the independent service before waiting for startup. User/system
 * shutdown during startup can then cancel the real host, not an empty pointer. */
export async function createDesktopRuntimeHost(ports){
  const service=await ports.createService();
  const host={service,ui:service.ui,status:service.lifecycle.status,reconcile:service.reconcile,shutdown:service.shutdown,
    command:async input=>{const receipt=await service.lifecycle.command(input);
      try{ports.setStartup?.(receipt.snapshot.intent.desired);}catch{receipt.warning='自动启动设置未能保存，运行控制已按回执处理。';}return receipt;}};
  ports.onCreated(host);
  if(ports.isQuitting()){await service.shutdown();return host;}
  await service.start();
  if(!ports.isQuitting())try{ports.setStartup?.(service.store.control().desired_intent);}catch(error){ports.onError?.(error);}
  return host;
}
