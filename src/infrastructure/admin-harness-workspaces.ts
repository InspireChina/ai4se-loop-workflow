import {createHash} from 'node:crypto';
import {lstat,mkdir,open,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {decodeHarnessSource,extractHarnessSource} from '../../scripts/harness-source.mjs';
import {originalRuntimeArtifact} from '../domain/runtime-original-artifact';
import type {AdminAuthority} from '../domain/repair-case';
import type {AdminManagementStore} from './admin-management-store';
import {sanitizeDiagnosticText} from './diagnostic-text';

/** Runs only in a fenced native capability child, before any business import.
 * Decode/restore work cannot block root renewals. Damaged executable bytes are
 * deliberately NOT executed or required to pass a healthy-image check: source
 * content must instead match the original trusted artifact's source identity. */
export async function prepareAdminHarnessWorkspaces(ports:{
  store:AdminManagementStore;authority:AdminAuthority;dataRoot:string;assertCurrent:()=>void;
}) {
  let prepared=0;
  for(const request of ports.store.pendingCommandActions(ports.authority)){
    const {claim,action,key}=request;if(action.kind!=='harness-workspace')continue;
    const guard=()=>{ports.assertCurrent();if(ports.store.readCommandSubmission(claim))throw new Error('Admin 已终止提交，停止准备 Harness 源码');};
    try{
      guard();
      const row=ports.store.observations(claim.repairCase.caseId).find(raw=>(raw as {observation_id:string}).observation_id===action.observationId) as {origin:string;evidence_json:string}|undefined;
      if(row?.origin!=='runtime')throw new Error('Harness 源码缺少原始 runtime 故障来源');
      const artifact=originalRuntimeArtifact(JSON.parse(row.evidence_json));
      const dataRoot=await realpath(ports.dataRoot);guard();
      const expectedRoot=join(dataRoot,'runtime-artifacts',artifact.artifactId);
      if((resolve(artifact.root)!==expectedRoot&&resolve(artifact.root)!==resolve(join(ports.dataRoot,'runtime-artifacts',artifact.artifactId)))
        ||await realpath(artifact.root)!==expectedRoot)throw new Error('原始 Harness artifact 不是实际独立内容寻址快照');guard();
      const read=async(name:string)=>{
        let parent=expectedRoot;
        for(const segment of name.split('/').slice(0,-1)){
          parent=join(parent,segment);guard();const info=await lstat(parent);guard();
          if(!info.isDirectory()||info.isSymbolicLink()||await realpath(parent)!==parent)throw new Error('Harness 输入父目录不安全');guard();
        }
        guard();const path=join(expectedRoot,name),before=await lstat(path);guard();
        if(!before.isFile()||before.nlink!==1||before.size>256*1024*1024)throw new Error('Harness 输入不是独立普通文件或超出上限');
        const handle=await open(path,'r');
        try{
          guard();const opened=await handle.stat();if(opened.ino!==before.ino||opened.dev!==before.dev)throw new Error('Harness 输入身份改变');
          const bytes=await handle.readFile();guard();const after=await handle.stat(),current=await lstat(path);guard();
          if(!current.isFile()||current.ino!==before.ino||current.dev!==before.dev||current.nlink!==1
            ||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Harness 输入读取期间改变');
          return bytes;
        }finally{await handle.close();}
      };
      const bytes=await read('harness-source.json.gz');guard();const source=decodeHarnessSource(bytes);guard();
      if(source.sourceId!==artifact.sourceId||source.version!==artifact.version
        ||source.build.buildId!==(await read('.next/BUILD_ID')).toString('utf8').trim())throw new Error('Harness 归档不是原始故障版本的准确源码');guard();
      let parent=dataRoot;
      for(const segment of ['admin','harness-workspaces',createHash('sha256').update(claim.repairCase.caseId).digest('hex'),claim.attempt.attemptId]){
        parent=join(parent,segment);guard();await mkdir(parent,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});guard();
        const info=await lstat(parent);guard();if(!info.isDirectory()||info.isSymbolicLink()||await realpath(parent)!==parent)throw new Error('Harness 私有工作区父目录不安全');guard();
      }
      const workspaceRoot=join(parent,'source');
      const result=await extractHarnessSource(bytes,workspaceRoot,{assertCurrent:guard});guard();
      ports.store.recordCommandActionResult(claim,key,'completed',{phase:'prepared',workspaceRoot,sourceArtifact:artifact,
        ...result,archiveHash:createHash('sha256').update(bytes).digest('hex'),
        authorization:{caseId:claim.repairCase.caseId,attemptId:claim.attempt.attemptId,generation:claim.attempt.generation,
          ownerId:claim.authority.ownerId,supervisionToken:claim.authority.token,intentRevision:claim.attempt.intentRevision},
        liveWorkspacePermission:false});prepared++;
    }catch(error){
      guard(); // Cancellation/fencing preserves the uncommitted action, not a false success.
      ports.store.recordCommandActionResult(claim,key,'failed',{error:sanitizeDiagnosticText(error instanceof Error?error.message:String(error))});
    }
  }
  return {prepared};
}
