import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';

test('native Workflow tool rejects missing input and transports exact UTF-8 through a cleaned execution file', async () => {
  const root=mkdtempSync(join(tmpdir(),'loopwork-native-extension-'));
  const env={LOOP_EXECUTION_TOKEN:'test-native-flow',LOOP_CONTEXT_CHAT_COMMAND_TOKEN:'',LOOP_APP_ROOT:root,LOOP_NODE:process.execPath,LOOP_AGENT_TMP_DIR:join(root,'temporary'),LOOP_EXTENSION_PROOF:join(root,'received.json')};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
  Object.assign(process.env,env);
  try {
    mkdirSync(join(root,'scripts','loop'),{recursive:true});
    symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
    writeFileSync(join(root,'scripts','loop','loopctl.ts'),"import {writeFileSync} from 'node:fs';writeFileSync(process.env.LOOP_EXTENSION_PROOF,JSON.stringify({route:'context',args:process.argv.slice(2)}));console.log('context read');");
    const fragmented='分段🙂原文🚁\n结束';
    writeFileSync(join(root,'scripts','loop','loop-agent.mjs'),`import {readFileSync,writeFileSync} from 'node:fs';const args=process.argv.slice(2);const path=args[args.indexOf('--content-file')+1];writeFileSync(process.env.LOOP_EXTENSION_PROOF,JSON.stringify({args,path,input:readFileSync(path,'utf8')}));
if(args.includes('--fragment-stdout')||args.includes('--fragment-stderr')){const output=args.includes('--fragment-stderr')?process.stderr:process.stdout;for(const byte of Buffer.from(${JSON.stringify(fragmented)})){output.write(Buffer.from([byte]));await new Promise(resolve=>setTimeout(resolve,3));}if(args.includes('--fragment-stderr'))process.exitCode=1;}
else if(args.includes('--nested-rejection'))console.log('# COMMAND RESULT\\n\\n- Command: phase complete\\n- Outcome: phase_completed\\n\\n# NEXT WORK PACKET\\n\\nHistorical receipt: Outcome: rejected');
else if(args.includes('--real-rejection'))console.log('# COMMAND RESULT\\n\\n- Command: artifact put\\n- Outcome: rejected\\n\\n# NEXT\\n\\nCorrect the input');
else console.log('accepted');`);
    type ToolParams={args:string[];input?:string|Record<string,unknown>};
    let tool: {loadMode:string;parameters:z.ZodType<ToolParams>;execute:(id:string,params:ToolParams,signal:AbortSignal)=>Promise<{content:{text:string}[]}>} | undefined;
    const register=(await import(pathToFileURL(resolve('scripts/omp-extension.mjs')).href)).default;
    register({zod:z,registerTool:(definition:typeof tool)=>{tool=definition;}});
    assert.ok(tool);
    assert.equal(tool.loadMode,'essential');
    const args=['artifact','put','--content-file','@input'];
    await assert.rejects(tool.execute('missing-input',{args},new AbortController().signal),/@input.*input 正文/);
    assert.equal(existsSync(env.LOOP_EXTENSION_PROOF),false);
    const input='标题\n"quoted" 与 \'single\' {{task.id}}\n\t保留空白🙂';
    const result=await tool.execute('utf8-input',{args,input},new AbortController().signal);
    const received=JSON.parse(readFileSync(env.LOOP_EXTENSION_PROOF,'utf8'));
    assert.equal(received.input,input);
    assert.ok(received.path.startsWith(env.LOOP_AGENT_TMP_DIR));
    assert.notEqual(received.args.at(-1),'@input');
    assert.equal(existsSync(received.path),false);
    assert.equal(result.content[0].text.trim(),'accepted');
    for(const kind of ['artifact','decision']){
      await tool.execute('implicit-content-'+kind,{args:[kind,'put','--key','stable-key'],input},new AbortController().signal);
      const bound=JSON.parse(readFileSync(env.LOOP_EXTENSION_PROOF,'utf8'));
      assert.equal(bound.input,input);
      assert.deepEqual(bound.args.slice(0,4),[kind,'put','--key','stable-key']);
      assert.equal(bound.args.at(-2),'--content-file');
      assert.equal(existsSync(bound.path),false);
    }
    const record={title:'中文 "标题": 🙂',content:'First line\n第二行',options:[{id:'one',label:'a: b'}],acceptance:['完整字符串'],count:3};
    for(const kind of ['artifact','decision']){
      const params=tool.parameters.parse({args:[kind,'put','--key','record'],input:record});
      await tool.execute('structured-'+kind,params,new AbortController().signal);
      const bound=JSON.parse(readFileSync(env.LOOP_EXTENSION_PROOF,'utf8'));
      assert.deepEqual(JSON.parse(bound.input),record);
      assert.equal(existsSync(bound.path),false);
    }
    await assert.rejects(tool.execute('invalid-structured-scope',{args:['direct','submit'],input:record},new AbortController().signal),/only supported by artifact put and decision put/);
    const nested=await tool.execute('nested-rejection',{args:['artifact','put','--nested-rejection'],input},new AbortController().signal);
    assert.match(nested.content[0].text, /Outcome: phase_completed/);
    await assert.rejects(tool.execute('real-rejection',{args:['artifact','put','--real-rejection'],input},new AbortController().signal),/Outcome: rejected/);
    const fragmentedOutput=await tool.execute('fragmented-output',{args:['artifact','put','--fragment-stdout'],input},new AbortController().signal);
    assert.equal(fragmentedOutput.content[0].text,fragmented);
    await assert.rejects(tool.execute('fragmented-error',{args:['artifact','put','--fragment-stderr'],input},new AbortController().signal),(error:Error)=>error.message===fragmented);
    const contextResult=await tool.execute('context-read',{args:['agent-context','get','DOC:test']},new AbortController().signal);
    const context=JSON.parse(readFileSync(env.LOOP_EXTENSION_PROOF,'utf8'));
    assert.equal(context.route,'context');
    assert.deepEqual(context.args,['agent-context','get','DOC:test']);
    assert.equal(contextResult.content[0].text.trim(),'context read');
  } finally {
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(root,{recursive:true,force:true});
  }
});
