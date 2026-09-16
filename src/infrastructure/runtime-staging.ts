import {cp,mkdir,mkdtemp,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import type {RuntimeArtifact} from '../domain/runtime-update';
import {assertRuntimeDataOutside} from './runtime-paths';

/** Import a verified build into a content-addressed installation directory.
 * Never point a repair transaction at a mutable build cache/installer root. */
export async function stageRuntimeArtifact(source:RuntimeArtifact,dataRoot:string,signal:AbortSignal,assertCurrent:()=>void):Promise<RuntimeArtifact> {
  const check=()=>{assertCurrent();if(signal.aborted)throw new Error('安装产物准备已取消');};check();
  await assertRuntimeDataOutside(source.root,dataRoot);check();
  const verify=async(root:string)=>{
    const actual=await readHarnessArtifact(root,{signal,assertCurrent:check});
    if(actual.artifactId!==source.artifactId||actual.sourceId!==source.sourceId||actual.version!==source.version)throw new Error('准备产物与已批准源码/安装身份不匹配');
    check();return actual;
  };
  await verify(source.root);
  const directory=join(dataRoot,'runtime-artifacts');await mkdir(directory,{recursive:true,mode:0o700});check();
  const target=join(directory,source.artifactId);
  try {return await verify(target);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const incoming=await mkdtemp(join(directory,'.incoming-'));const candidate=join(incoming,'artifact');
  await cp(source.root,candidate,{recursive:true,verbatimSymlinks:true,filter:()=>{check();return true;}});check();
  await verify(candidate);await verify(source.root);check();
  try {await rename(candidate,target);}
  catch(error){if(!['EEXIST','ENOTEMPTY','EPERM'].includes((error as NodeJS.ErrnoException).code||''))throw error;}
  // A competing stager can win the atomic directory publication. Its bytes
  // must still match; a corrupt/partial existing destination is never replaced.
  return verify(target);
}
