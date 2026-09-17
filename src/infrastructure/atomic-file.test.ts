import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';

test('atomic control-file replacement never exposes truncated JSON to another process',async()=>{
  const directory=join(process.env.LOOP_DATA_ROOT!,`atomic-file-${randomUUID()}`);await mkdir(directory,{recursive:true});
  const path=join(directory,'allocation.json');await writeFile(path,JSON.stringify({revision:0,payload:'initial'}));
  const modulePath=new URL('./atomic-file.ts',import.meta.url).href;
  const script=`import {atomicReplaceFileSync} from ${JSON.stringify(modulePath)};
    const path=process.argv[1];process.stdout.write('ready\\n');
    setTimeout(()=>{for(let revision=1;revision<=1000;revision++)atomicReplaceFileSync(path,JSON.stringify({revision,payload:'x'.repeat(4096)}));},20);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','--eval',script,path],{stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const closed=new Promise<number>(resolve=>child.once('close',code=>resolve(code??-1)));
  const ready=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',()=>resolve());});
  await Promise.race([ready,closed.then(code=>{throw new Error(`atomic writer exited before ready (${code}): ${stderr}`);})]);
  let reads=0;
  while(child.exitCode===null) {
    const value=JSON.parse(await readFile(path,'utf8')) as {revision:number;payload:string};
    assert.equal(typeof value.revision,'number');assert.equal(typeof value.payload,'string');reads++;
  }
  assert.equal(await closed,0,stderr);
  assert.ok(reads>0);assert.equal(JSON.parse(await readFile(path,'utf8')).revision,1000);
  assert.deepEqual((await readdir(directory)).sort(),['allocation.json']);
});
