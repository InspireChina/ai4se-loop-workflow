import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export default function loopwork(pi) {
  const chat=Boolean(process.env.LOOP_CONTEXT_CHAT_COMMAND_TOKEN);
  const flow=Boolean(process.env.LOOP_EXECUTION_TOKEN||process.env.LOOP_INTERNAL_COMMAND_TOKEN||process.env.LOOP_VERIFICATION_ASSISTANCE_COMMAND_TOKEN);
  if(!chat&&!flow)return;
  const z=pi.zod;
  if(!z)throw new Error('This OMP build does not expose the native extension schema API');
  pi.registerTool({
    name:'loopwork',label:'LoopWork Workflow',
    description:'Read the current workflow status and submit authorized workflow artifacts or results. Pass only arguments after the loop-agent/loopctl command prefix. Optional input is UTF-8 text; use @input as its file argument. This tool cannot execute shell commands. Examples: {args:["direct","run"]}; {args:["direct","submit","--summary","Done","--result-file","@input"],input:"Full Markdown result"}. Use --summary for inline text. All -file arguments must use @input or refer to an existing execution temporary file; never invent file paths.',
    parameters:z.object({args:z.array(z.string()).min(1),input:z.string().optional()}),
    async execute(_id,params,signal) {
      if(chat&&!['task-context','task-get','task-dispatch-inspect','run-status','document-list','document-get','context-chat-change'].includes(params.args[0]))throw new Error('Context chat cannot call that workflow command');
      const root=process.env.LOOP_APP_ROOT;
      if(!root)throw new Error('Missing LoopWork application root');
      let file;
      const args=[...params.args];
      if(args[0]?.includes(' --')) { const compact=args.shift(); args.unshift(...(compact.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)||[]).map(value=>value.replace(/^(["'])(.*)\1$/,'$2'))); }
      if(params.input!==undefined){
        const directory=process.env.LOOP_AGENT_TMP_DIR||process.env.LOOP_TASK_TEMP_DIR;
        if(!directory)throw new Error('No execution temporary directory is available');
        mkdirSync(directory,{recursive:true});file=join(directory,`omp-${randomUUID()}.txt`);
        writeFileSync(file,params.input,{mode:0o600});
        for(let i=0;i<args.length;i++)if(args[i]==='@input')args[i]=file;
      }
      try {
        const result=await new Promise((resolve,reject)=>{
          const entry=chat?['--import','tsx',join(root,'scripts','loop','loopctl.ts')]:[join(root,'scripts','loop','loop-agent.mjs')];
          const child=spawn(process.env.LOOP_NODE||'node',[...entry,...args],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
          let text='',error='';const append=(chunk)=>{text=(text+chunk).slice(-100000);};
          child.stdout.on('data',append);child.stderr.on('data',chunk=>{error=(error+chunk).slice(-12000);});
          const abort=()=>child.kill('SIGTERM');const timeout=setTimeout(abort,120000);
          signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
          child.once('error',reject);child.once('close',code=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);code===0?resolve(text):reject(new Error(error||text||`Workflow command exited ${code}`));});
        });
        if (/Outcome: rejected/.test(String(result))) throw new Error(String(result)+'\nUse separate argument entries. For inline summary use --summary; for input files use --result-file @input with input containing the Markdown.');
        return {content:[{type:'text',text:String(result)}],details:{command:args[0]}};
      } finally {if(file)rmSync(file,{force:true});}
    },
  });
}
