import {randomUUID} from 'node:crypto';
import {uiLifecycleActionSchema} from '../domain/ui-lifecycle-protocol';
import type {ExternalLifecycleView} from '../application/external-lifecycle-adapter';
import type {ExternalRuntimeControlReceipt} from '../application/external-runtime-controls';

/** Private child-to-parent bridge. It never falls back to creating a local
 * lifecycle host, even on timeout, malformed replies, or parent disconnect. */
export function createExternalUiLifecycleClient(){
  const allocationId=process.env.LOOP_EXTERNAL_UI_ALLOCATION;
  if(!allocationId||!process.connected||!process.send)throw new Error('外部界面缺少实际私有父宿主通道');
  const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  const close=()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('独立界面父宿主已失效'));}pending.clear();};
  process.once('disconnect',close);
  process.on('message',message=>{
    if(!message||typeof message!=='object'||!('kind'in message)||message.kind!=='ui-lifecycle-response'
      ||!('allocationId'in message)||message.allocationId!==allocationId||!('requestId'in message)||typeof message.requestId!=='string')return;
    const request=pending.get(message.requestId);if(!request)return;
    pending.delete(message.requestId);clearTimeout(request.timer);
    if('ok'in message&&message.ok===true&&'value'in message)request.resolve(message.value);
    else request.reject(new Error('独立宿主拒绝界面生命周期请求'));
  });
  function request(operation:'status'|'command',command?:unknown):Promise<unknown>{
    if(!process.connected||pending.size>=32)return Promise.reject(new Error('独立宿主通道失效或请求积压'));
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('独立宿主生命周期请求超时'));},90000);
      pending.set(requestId,{resolve,reject,timer});
      try{process.send!({kind:'ui-lifecycle-request',allocationId,requestId,operation,...(command?{command}:{})},error=>{
        if(error){const current=pending.get(requestId);if(current){pending.delete(requestId);clearTimeout(current.timer);current.reject(error);}}
      });}catch(error){pending.delete(requestId);clearTimeout(timer);reject(error);}
    });
  }
  return {
    status:()=>request('status') as Promise<ExternalLifecycleView>,
    command:(input:{requestId:string;action:unknown;source?:unknown})=>{
      const action=uiLifecycleActionSchema.parse(input.action);
      return request('command',{requestId:input.requestId,action}) as Promise<ExternalRuntimeControlReceipt&{snapshot:ExternalLifecycleView;error?:string}>;
    },
  };
}
