import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFile,lstat,mkdir,mkdtemp,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {captureHarnessSource,encodeHarnessSource,extractHarnessSource} from '../../scripts/harness-source.mjs';
import {harnessBuildEnvironment,harnessTestEnvironment} from '../../scripts/harness-build-environment.mjs';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import type {AdminAuthority} from '../domain/repair-case';
import type {AdminManagementStore} from './admin-management-store';
import {stageRuntimeArtifact} from './runtime-staging';
import {sanitizeDiagnosticText} from './diagnostic-text';

/** Only a native fenced build capability may call this. Subprocesses inherit
 * its registered process group; root cleanup confirms every descendant gone.
 * No live business data, command credential or caller-selected shell command. */
export async function runHarnessBuildStage(input:{node:string;args:string[];workspaceRoot:string;env:NodeJS.ProcessEnv;
  assertCurrent:()=>void;logFile:string;stage:string}){
  input.assertCurrent();await appendFile(input.logFile,`\n# Harness build stage: ${input.stage}\n`);input.assertCurrent();
  const cancellation=new AbortController();let outputError:unknown;let tail='';let output=Promise.resolve();
  const child=spawn(input.node,input.args,{cwd:input.workspaceRoot,env:input.env,stdio:['ignore','pipe','pipe'],windowsHide:true,signal:cancellation.signal});
  const write=(bytes:Buffer)=>{
    tail=(tail+bytes.toString('utf8')).slice(-16000);
    output=output.then(()=>appendFile(input.logFile,sanitizeDiagnosticText(bytes.toString('utf8'),bytes.length*4+100))).catch(error=>{
      outputError=error;cancellation.abort(error);
    });
  };
  child.stdout!.on('data',write);child.stderr!.on('data',write);
  let failure:unknown;
  const timer=setInterval(()=>{try{input.assertCurrent();}catch(error){failure=error;cancellation.abort(error);}},100);
  try{
    const code=await new Promise<number|null>((done)=>{
      child.once('error',error=>{failure??=error;});child.once('close',done);
    });
    await output;input.assertCurrent();
    if(failure||outputError)throw failure??outputError;
    if(code!==0)throw new Error(`Harness ${input.stage} failed code=${code}: ${sanitizeDiagnosticText(tail)}`);
    return {stage:input.stage,exitCode:0};
  }finally{clearInterval(timer);}
}

async function locateToolchain(workspaceRoot:string,env:NodeJS.ProcessEnv,assertCurrent:()=>void,logFile:string){
  // Resolve the actual installed Node/npm pair; never run npm.cmd through a
  // shell, or silently replace the configured Agent executor. Missing build
  // prerequisites are a recorded repair failure, not a successful candidate.
  const source=`const f=require('node:fs'),p=require('node:path');const d=p.dirname(process.execPath);
const candidates=[p.resolve(d,'../lib/node_modules/npm/bin/npm-cli.js'),p.join(d,'node_modules/npm/bin/npm-cli.js')];
const npm=candidates.find(x=>f.existsSync(x));if(!npm)throw new Error('Installed Node has no npm CLI');
f.writeFileSync(process.argv[1],JSON.stringify({node:f.realpathSync(process.execPath),npm:f.realpathSync(npm),version:process.version,platform:process.platform,arch:process.arch}),{flag:'wx'});`;
  const filename=join(workspaceRoot,'toolchain.json');
  await runHarnessBuildStage({node:'node',args:['--eval',source,filename],workspaceRoot,env,assertCurrent,logFile,stage:'locate-toolchain'});
  const {readFile}=await import('node:fs/promises');
  const toolchain=JSON.parse(await readFile(filename,'utf8')) as {node:string;npm:string;version:string;platform:string;arch:string};
  if(!toolchain.version.startsWith('v24.')||toolchain.platform!==process.platform||toolchain.arch!==process.arch)throw new Error('Harness 构建需要本机 Node 24 和 npm，不能使用不匹配的构建环境');
  return toolchain;
}

export async function buildAdminHarnessCandidates(ports:{store:AdminManagementStore;authority:AdminAuthority;dataRoot:string;assertCurrent:()=>void}){
  let built=0;
  for(const request of ports.store.pendingCommandActions(ports.authority)){
    const {claim,action,key}=request;if(action.kind!=='harness-build')continue;
    const check=()=>{ports.assertCurrent();if(ports.store.readCommandSubmission(claim))throw new Error('Admin 已终止提交，停止构建 Harness');};
    let failedLogFile:string|undefined;
    try{
      check();const anchor=ports.store.harnessWorkspaceSource(claim,action.workspaceKey),dataRoot=await realpath(ports.dataRoot);check();
      let parent=dataRoot;
      for(const segment of ['admin','harness-workspaces',createHash('sha256').update(claim.repairCase.caseId).digest('hex'),claim.attempt.attemptId]){
        parent=join(parent,segment);const info=await lstat(parent);check();
        if(!info.isDirectory()||info.isSymbolicLink()||await realpath(parent)!==parent)throw new Error('Harness 构建父目录不是实际私有目录');check();
      }
      const workspaceRoot=join(parent,'source');
      if(resolve(anchor.workspaceRoot)!==workspaceRoot||await realpath(workspaceRoot)!==workspaceRoot||(await lstat(workspaceRoot)).isSymbolicLink())throw new Error('Harness 构建源码目录不匹配本轮准备动作');check();
      const source=await captureHarnessSource(workspaceRoot);check();
      const invalidReuse=(error:unknown)=>{
        const detail=sanitizeDiagnosticText(error instanceof Error?error.message:String(error));
        ports.store.recordEvidence(claim,`harness-reuse-invalid:${createHash('sha256').update(detail).digest('hex')}`,'finding',{error:detail,sourceId:source.sourceId});
      };
      let reused=false;
      for(const reusable of ports.store.reusableHarnessCandidates(source.sourceId,claim.attempt.attemptId,invalidReuse)){
        let actual:Awaited<ReturnType<typeof readHarnessArtifact>>;
        try{
          check();const expected=join(dataRoot,'runtime-artifacts',reusable.candidate.artifactId);
          const info=await lstat(reusable.candidate.root);check();
          if(resolve(reusable.candidate.root)!==expected||await realpath(reusable.candidate.root)!==expected
            ||!info.isDirectory()||info.isSymbolicLink())throw new Error('历史 Harness 候选不是实际内容寻址目录');
          actual=await readHarnessArtifact(expected,{assertCurrent:check});check();
          if(JSON.stringify(actual)!==JSON.stringify(reusable.candidate)||actual.sourceId!==source.sourceId||actual.version!==source.version) {
            throw new Error('历史 Harness 候选实际字节、源码或版本已变化');
          }
        }catch(error){invalidReuse(error);continue;}
        if((await captureHarnessSource(workspaceRoot)).sourceId!==source.sourceId)throw new Error('Harness 候选复用期间源码发生变化');check();
        const buildRoot=await mkdtemp(join(parent,'build-'));check();
        const frozen=join(buildRoot,'source'),logFile=join(buildRoot,'build.log');failedLogFile=logFile;
        await appendFile(logFile,`# Reused immutable Harness candidate ${actual.artifactId}\n`);check();
        await extractHarnessSource(encodeHarnessSource(source,{buildId:`reuse-${actual.artifactId.slice(0,32)}`}),frozen,{assertCurrent:check});check();
        if((await captureHarnessSource(frozen)).sourceId!==source.sourceId||(await captureHarnessSource(workspaceRoot)).sourceId!==source.sourceId) {
          throw new Error('Harness 候选复用的当前冻结源码已变化');
        }
        const reusedFrom={attemptId:reusable.attemptId,buildKey:reusable.buildKey,candidateArtifactId:actual.artifactId,sourceId:source.sourceId};
        ports.store.recordEvidence(claim,`harness-build:${key}:reused`,'management-action',{sourceId:source.sourceId,candidate:actual,reusedFrom,logFile});
        ports.store.recordCommandActionResult(claim,key,'completed',{phase:'candidate-built',candidate:actual,sourceArtifact:anchor.sourceArtifact,
          sourceId:source.sourceId,workspaceRoot,frozenWorkspaceRoot:frozen,toolchain:reusable.toolchain,receipts:reusable.receipts,logFile,reusedFrom,
          independentVerificationRequired:true,liveWorkspacePermission:false});built++;
        reused=true;break;
      }
      if(reused)continue;
      const buildRoot=await mkdtemp(join(parent,'build-'));check();
      const frozen=join(buildRoot,'source'),logFile=join(buildRoot,'build.log');
      failedLogFile=logFile;
      ports.store.recordEvidence(claim,`harness-build:${key}:started`,'management-action',{sourceId:source.sourceId,buildRoot,logFile,sourceArtifact:anchor.sourceArtifact});
      await extractHarnessSource(encodeHarnessSource(source,{buildId:'candidate-frozen-source'}),frozen,{assertCurrent:check});check();
      const env=harnessBuildEnvironment(buildRoot,frozen);delete env.ELECTRON_RUN_AS_NODE;delete env.LOOP_DESKTOP_NODE;
      await mkdir(env.LOOP_DATA_ROOT!,{mode:0o700});await mkdir(env.LOOP_WORKSPACE_ROOT!,{mode:0o700});check();
      const toolchain=await locateToolchain(buildRoot,env,check,logFile),receipts=[];
      const stages=[{stage:'dependencies',args:[toolchain.npm,'ci','--include=dev','--no-audit','--no-fund']},
        {stage:'tests',args:[toolchain.npm,'test']},{stage:'typescript',args:[join(frozen,'node_modules/typescript/bin/tsc'),'--noEmit']},
        {stage:'next-build',args:[toolchain.npm,'run','build']},{stage:'desktop-build',args:[toolchain.npm,'run','build:desktop-runtime']}];
      for(const stage of stages){
        check();receipts.push(await runHarnessBuildStage({...stage,node:toolchain.node,workspaceRoot:frozen,
          env:stage.stage==='tests'?harnessTestEnvironment(env):env,assertCurrent:check,logFile}));check();
        ports.store.recordEvidence(claim,`harness-build:${key}:${stage.stage}`,'management-action',{...receipts.at(-1),sourceId:source.sourceId,logFile});
      }
      if((await captureHarnessSource(workspaceRoot)).sourceId!==source.sourceId||(await captureHarnessSource(frozen)).sourceId!==source.sourceId)throw new Error('Harness 构建期间源码发生变化，不能登记候选');check();
      const artifact=await readHarnessArtifact(join(frozen,'desktop-runtime'),{assertCurrent:check});check();
      if(artifact.sourceId!==source.sourceId||artifact.version!==source.version)throw new Error('实际候选版本不匹配冻结源码');
      const candidate=await stageRuntimeArtifact(artifact,dataRoot,new AbortController().signal,check);check();
      ports.store.recordCommandActionResult(claim,key,'completed',{phase:'candidate-built',candidate,sourceArtifact:anchor.sourceArtifact,
        sourceId:source.sourceId,workspaceRoot,frozenWorkspaceRoot:frozen,toolchain,receipts,logFile,
        independentVerificationRequired:true,liveWorkspacePermission:false});built++;
    }catch(error){
      check();ports.store.recordCommandActionResult(claim,key,'failed',{error:sanitizeDiagnosticText(error instanceof Error?error.message:String(error)),...(failedLogFile?{logFile:failedLogFile}:{})});
    }
  }
  return {built};
}
