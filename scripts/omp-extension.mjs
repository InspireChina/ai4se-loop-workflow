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
    // Workflow control must remain visible even when OMP defers optional tools.
    loadMode:'essential',
    description:'Read the current workflow status and submit authorized workflow artifacts or results. Pass only arguments after the loop-agent/loopctl command prefix. For artifact put and decision put, input is the content body; no file flag is needed. Prefer a structured JSON object for schema-defined records rather than hand-written YAML. Use UTF-8 text for Markdown blocks. Objects are serialized without changing field values; the workflow still validates the original schema. Other file inputs use @input as their file argument and require text input. This tool cannot execute shell commands. Examples: {args:["artifact","put","--artifact","ID","--block","ID","--key","KEY"],input:{title:"Title",content:"Text"}}; {args:["direct","submit","--summary","Done","--result-file","@input"],input:"Full Markdown result"}. Use --summary for inline text. All -file arguments must use @input or refer to an existing execution temporary file; never invent file paths. args 出现 @input 时必须同时传 input 正文；Shell 不支持 @input，请使用真实临时文件路径。',
    parameters:z.object({args:z.array(z.string()).min(1),input:z.union([z.string(),z.record(z.string(),z.unknown())]).optional()}),
    async execute(_id,params,signal) {
      if(chat&&!['task-context','task-get','task-dispatch-inspect','run-status','document-list','document-get','context-chat-change'].includes(params.args[0]))throw new Error('Context chat cannot call that workflow command');
      const root=process.env.LOOP_APP_ROOT;
      if(!root)throw new Error('Missing LoopWork application root');
      let file;
      const args=[...params.args];
      if(args[0]?.includes(' --')) { const compact=args.shift(); args.unshift(...(compact.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)||[]).map(value=>value.replace(/^(["'])(.*)\1$/,'$2'))); }
      const singleRecord=!chat&&['artifact','decision'].includes(args[0])&&args[1]==='put';
      if(params.input!==undefined&&typeof params.input!=='string'&&!singleRecord)throw new Error('Structured input is only supported by artifact put and decision put. Other command bodies must be text.');
      // These two commands have exactly one content body. Bind the native tool's
      // input without exposing filesystem transport details to the model.
      // Explicit content flags and multi-body/control commands remain unchanged.
      if(singleRecord&&params.input!==undefined
        &&!args.includes('--content')&&!args.includes('--content-file'))args.push('--content-file','@input');
      if(args.includes('@input')&&params.input===undefined)throw new Error('@input 需要同时提供 input 正文，例如 {args:["artifact","put","--artifact","ID","--block","ID","--content-file","@input"],input:"完整正文"}。不能把 @input 当作已有文件或 Shell 路径。');
      if(params.input!==undefined){
        const directory=process.env.LOOP_AGENT_TMP_DIR||process.env.LOOP_TASK_TEMP_DIR;
        if(!directory)throw new Error('No execution temporary directory is available');
        mkdirSync(directory,{recursive:true});file=join(directory,`omp-${randomUUID()}.txt`);
        writeFileSync(file,typeof params.input==='string'?params.input:JSON.stringify(params.input),{encoding:'utf8',mode:0o600});
        for(let i=0;i<args.length;i++)if(args[i]==='@input')args[i]=file;
      }
      try {
        const result=await new Promise((resolve,reject)=>{
          // Context reads keep the same role/token checks as their CLI entry.
          const entry=chat||args[0]==='agent-context'?['--import','tsx',join(root,'scripts','loop','loopctl.ts')]:[join(root,'scripts','loop','loop-agent.mjs')];
          const child=spawn(process.env.LOOP_NODE||'node',[...entry,...args],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
          child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
          let text='',error='';const append=(chunk)=>{text=(text+chunk).slice(-100000);};
          child.stdout.on('data',append);child.stderr.on('data',chunk=>{error=(error+chunk).slice(-12000);});
          const abort=()=>child.kill('SIGTERM');const timeout=setTimeout(abort,120000);
          signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
          child.once('error',reject);child.once('close',code=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);code===0?resolve(text):reject(new Error(error||text||`Workflow command exited ${code}`));});
        });
        // Only the current protocol header determines success. Frozen documents
        // and historical receipts may legitimately quote an older rejection.
        const header=/^# COMMAND RESULT\r?\n[\s\S]*?(?=\r?\n#{1,2} |$)/.exec(String(result))?.[0];
        if (/^- Outcome:[ \t]*rejected\b/m.test(header||'')) throw new Error(String(result)+'\nUse separate argument entries. For inline summary use --summary; for input files use --result-file @input with input containing the Markdown.');
        return {content:[{type:'text',text:String(result)}],details:{command:args[0]}};
      } finally {if(file)rmSync(file,{force:true});}
    },
  });
}
