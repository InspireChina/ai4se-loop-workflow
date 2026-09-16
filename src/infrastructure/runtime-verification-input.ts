import {createHash} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {captureHarnessSource} from '../../scripts/harness-source.mjs';
import {readHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import type {IndependentVerificationInput} from '../domain/independent-verification-preparation';
import type {AdminManagementStore} from './admin-management-store';

/** Native read-only check: no business imports, migrations or workflow writes.
 * A completed build record alone cannot authorize a mutable/foreign image. */
export async function assertRuntimeVerificationInput(input:IndependentVerificationInput,ports:{
  store:AdminManagementStore;caseId:string;dataRoot:string;assertCurrent:()=>void;signal?:AbortSignal;
}) {
  if(input.kind!=='runtime')throw new Error('runtime 入口拒绝业务验收上下文');
  const check=()=>{ports.assertCurrent();ports.signal?.throwIfAborted();};check();
  const dataRoot=await realpath(ports.dataRoot);check();
  const ownerRoot=join(dataRoot,'admin','harness-workspaces',createHash('sha256').update(ports.caseId).digest('hex'),input.sourceRepairAttemptId);
  const buildRoot=dirname(input.workspaceRoot);
  if(dirname(buildRoot)!==ownerRoot||!/^build-[A-Za-z0-9]+$/.test(basename(buildRoot))||basename(input.workspaceRoot)!=='source'
    ||resolve(input.workspaceRoot)!==input.workspaceRoot)throw new Error('runtime 验收源码不属于本轮私有冻结构建');
  let parent=dataRoot;
  for(const segment of ['admin','harness-workspaces',basename(dirname(ownerRoot)),input.sourceRepairAttemptId,basename(buildRoot),'source']) {
    parent=join(parent,segment);const info=await lstat(parent);check();
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(parent)!==parent)throw new Error('runtime 验收源码路径存在别名或非私有目录');check();
  }
  const candidate=input.runtimeBinding.candidate;
  if(candidate.root!==join(dataRoot,'runtime-artifacts',candidate.artifactId)||await realpath(candidate.root)!==candidate.root)
    throw new Error('runtime 验收候选不是本机内容寻址的实际安装');check();
  if(ports.store.adminBusinessWorkers(true).some(row=>row.operation==='harness-build'))throw new Error('候选构建进程尚未实际退出，禁止验证复用源码');
  if((await captureHarnessSource(input.workspaceRoot)).sourceId!==candidate.sourceId)throw new Error('runtime 验收冻结源码已变化');check();
  const actual=await readHarnessArtifact(candidate.root,{signal:ports.signal,assertCurrent:check});check();
  if(JSON.stringify(actual)!==JSON.stringify(candidate)||input.expectedVersion!==actual.artifactId)throw new Error('runtime 验收候选的实际字节或身份已变化');
}
