import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostParentWatch } from './host-parent-watch';

test('parent watcher coalesces startup, checks cheap availability and detects PID generation reuse without signaling parent', async () => {
  let now=0;let marker='original-parent';let reads=0;const lost:string[]=[];
  const watch=createHostParentWatch({now:()=>now,isAvailable:()=>true,readIdentity:async()=>{reads++;return marker;},onLost:async error=>{lost.push(error.message);}});
  try{
    await Promise.all([watch.start(),watch.start()]);await watch.check();assert.equal(reads,1);
    now=30_000;marker='reused-parent';await watch.check();await watch.check();
    assert.equal(reads,2);assert.equal(lost.length,1);assert.match(lost[0]!,/身份已改变/);
    await assert.rejects(watch.start(),/不能重新启动/);
  }finally{watch.stop();}
});

test('parent identity absence or query failure never authorizes a host under unknown ownership', async () => {
  const start=createHostParentWatch({isAvailable:()=>true,readIdentity:async()=>null,onLost:async()=>undefined});
  await assert.rejects(start.start(),/无法确认/);start.stop();
  let now=0;let reads=0;let lost=0;
  const watch=createHostParentWatch({now:()=>now,isAvailable:()=>true,readIdentity:async()=>{if(reads++)throw new Error('OS lookup unavailable');return 'parent';},onLost:async()=>{lost++;}});
  try{await watch.start();now=30_000;await watch.check();assert.equal(lost,1);}finally{watch.stop();}
});

test('slow parent identity query does not block cheap death detection or restart observation after stop', async () => {
  let now=0;let available=true;let reads=0;let lost=0;let release!:(value:string)=>void;
  const pending=new Promise<string>(resolve=>{release=resolve;});
  const watch=createHostParentWatch({now:()=>now,isAvailable:()=>available,readIdentity:async()=>++reads===1?'parent':pending,onLost:async()=>{lost++;}});
  try{
    await watch.start();now=30_000;const checking=watch.check();
    available=false;await watch.check();assert.equal(lost,1);
    release('parent');await checking;assert.equal(lost,1);
  }finally{release('parent');watch.stop();}
});
