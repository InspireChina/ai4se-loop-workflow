import { getRunStatus, readLoopRunLogChunk } from '../../../../src/application/tasks';
import { parseRunLog } from '../../../../src/application/run-log';
import { subscribeRuntimeEvents } from '../../../../src/infrastructure/runtime-event-hub';
export const dynamic='force-dynamic';
export const runtime='nodejs';
const encoder=new TextEncoder();
export async function GET(request: Request) {
  const runId=new URL(request.url).searchParams.get('runId')||'';
  if(!/^[a-zA-Z0-9-]+$/.test(runId))return new Response('Invalid run ID',{status:400});
  let cleanup=()=>{};
  const stream=new ReadableStream<Uint8Array>({
    start(controller){
      let closed=false, afterId=0, sending=false, pending=false;
      const send=(data:string)=>{if(closed)return;try{controller.enqueue(encoder.encode(data));}catch{cleanup();}};
      const refresh=async()=>{
        pending=true;if(sending)return;sending=true;
        try{while(pending&&!closed){
          pending=false;
          const chunk=await readLoopRunLogChunk(runId,afterId);
          if(chunk.raw){afterId=chunk.lastId;send(`data: ${JSON.stringify({raw:chunk.raw,events:parseRunLog(chunk.raw)})}\n\n`);}
          const run=await getRunStatus();
          if(!run?.active||run.runId!==runId){send('event: done\ndata: "done"\n\n');cleanup();}
        }}catch{send(': reconnecting\n\n');}finally{sending=false;}
      };
      const subscription=subscribeRuntimeEvents({topics:['run.logs-appended','dispatch.invalidated'],onReady:refresh,onEvent:(event)=>{if(!event.entityId||event.entityId===runId||event.topic==='dispatch.invalidated')void refresh();}});
      // Reconciliation is a fallback for a lost event; normal delivery is event-driven.
      const timer=setInterval(()=>{send(': keep-alive\n\n');void refresh();},15000);timer.unref();
      cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);subscription.close();request.signal.removeEventListener('abort',cleanup);try{controller.close();}catch{}};
      request.signal.addEventListener('abort',cleanup,{once:true});
      if(request.signal.aborted)cleanup();else void refresh();
    },cancel(){cleanup();},
  });
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'}});
}
