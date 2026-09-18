import assert from 'node:assert/strict';
import test from 'node:test';
import {createSingleFlight} from './single-flight';

test('single flight shares an in-progress operation and permits the next run after settlement',async()=>{
  let calls=0;const releases:Array<(value:number)=>void>=[];
  const flight=createSingleFlight(()=>new Promise<number>(resolve=>{calls++;releases.push(resolve);}));
  const first=flight.run(),concurrent=flight.run();
  assert.strictEqual(concurrent,first);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  releases[0](1);assert.deepEqual(await Promise.all([first,concurrent]),[1,1]);assert.equal(flight.current(),undefined);
  const next=flight.run();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
  releases[1](2);assert.equal(await next,2);
});
