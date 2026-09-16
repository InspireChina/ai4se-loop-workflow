import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readHarnessArtifact,readHarnessSourceBinding} from '../../scripts/harness-artifact.mjs';
import {stageRuntimeArtifact} from './runtime-staging';
import type {RuntimeArtifact} from '../domain/runtime-update';
import type {AdminManagementStore} from './admin-management-store';
import {sanitizeDiagnosticText} from './diagnostic-text';

/** Management construction cannot rely solely on the mutable business install.
 * Previously bound immutable root snapshots are candidates, not trusted health
 * receipts: recheck actual bytes, path and identity before using any helper. */
export async function resolveNativeBootstrap(ports:{
  appRoot:string;managementRoot?:string;dataRoot:string;signal:AbortSignal;
  store:Pick<AdminManagementStore,'runtimeBootstrapCandidates'|'observe'>;
  onError?:(error:unknown)=>void;
}):Promise<{bootstrap:RuntimeArtifact;installationError?:string}>{
  const check=()=>ports.signal.throwIfAborted();check();
  const report=(error:unknown)=>{try{ports.onError?.(error);}catch{/* diagnostics cannot remove recovery */}};
  let installedError:unknown;
  try{
    const source=await readHarnessArtifact(ports.appRoot,{signal:ports.signal});check();
    return {bootstrap:await stageRuntimeArtifact(source,ports.dataRoot,ports.signal,check)};
  }catch(error){check();installedError=error;report(error);}
  const failures:unknown[]=[installedError];
  const installationError=sanitizeDiagnosticText(installedError instanceof Error?installedError.message:String(installedError),16000);
  const failureId=createHash('sha256').update(JSON.stringify([ports.appRoot,installationError])).digest('hex');
  let installedBinding:Awaited<ReturnType<typeof readHarnessSourceBinding>>|undefined;
  try{installedBinding=await readHarnessSourceBinding(ports.appRoot,{signal:ports.signal});check();}
  catch(error){check();failures.push(error);report(error);}
  const candidates:RuntimeArtifact[]=[];
  if(ports.managementRoot&&resolve(ports.managementRoot)!==resolve(ports.appRoot)){
    try{
      const management=await readHarnessArtifact(ports.managementRoot,{signal:ports.signal});check();
      candidates.push(await stageRuntimeArtifact(management,ports.dataRoot,ports.signal,check));check();
    }catch(error){check();failures.push(error);report(error);}
  }
  candidates.push(...ports.store.runtimeBootstrapCandidates(report));
  const ordered=[...new Map(candidates.map(candidate=>[JSON.stringify([candidate.root,candidate.artifactId]),candidate])).values()]
    .sort((left,right)=>Number(Boolean(installedBinding&&right.sourceId===installedBinding.sourceId&&right.version===installedBinding.version))
      -Number(Boolean(installedBinding&&left.sourceId===installedBinding.sourceId&&left.version===installedBinding.version)));
  for(const candidate of ordered){
    check();
    try{
      if(resolve(candidate.root)!==resolve(join(ports.dataRoot,'runtime-artifacts',candidate.artifactId)))throw new Error('缓存 root 不是已绑定的内容寻址快照');
      const actual=await readHarnessArtifact(candidate.root,{signal:ports.signal});check();
      if(JSON.stringify(actual)!==JSON.stringify(candidate))throw new Error('缓存 root 实际字节身份与持久化绑定不符');
      let exactSource:Record<string,unknown>={};
      if(installedBinding&&installedBinding.sourceId===actual.sourceId&&installedBinding.version===actual.version){
        const sourceBinding=await readHarnessSourceBinding(actual.root,{signal:ports.signal});check();
        exactSource={sourceArtifact:actual,sourceEquivalence:{installedRoot:installedBinding.root,sourceId:installedBinding.sourceId,
          version:installedBinding.version,buildId:installedBinding.buildId,declaredArtifactId:installedBinding.declaredArtifactId,
          archiveHash:installedBinding.archiveHash,sourceArtifactId:actual.artifactId,sourceBuildId:sourceBinding.buildId}};
      }
      const sourceKey=installedBinding?`${installedBinding.sourceId}:${installedBinding.version}`:'unknown-source';
      ports.store.observe({observationId:`bootstrap-unavailable:${candidate.artifactId}:${failureId}:${createHash('sha256').update(sourceKey).digest('hex')}`,
        scope:'runtime',scopeKey:'installed-bootstrap',fingerprint:'bootstrap-unavailable',origin:'runtime',
        sourceVersion:installedBinding?`source:${installedBinding.sourceId}/declared-artifact:${installedBinding.declaredArtifactId}/version:${installedBinding.version}`:'unknown-installed',
        summary:installationError,evidence:{kind:'bootstrap-unavailable',installedRoot:ports.appRoot,managementBootstrap:actual,...exactSource}});
      return {bootstrap:actual,installationError};
    }catch(error){check();failures.push(error);report(error);}
  }
  // No verified repair helper exists yet. Keep the independent fact even
  // though constructing this native service must fail closed and be retried.
  check();
  const sourceKey=installedBinding?`${installedBinding.sourceId}:${installedBinding.version}`:'unknown-source';
  ports.store.observe({observationId:`bootstrap-unavailable:no-verified-cache:${failureId}:${createHash('sha256').update(sourceKey).digest('hex')}`,
    scope:'runtime',scopeKey:'installed-bootstrap',fingerprint:'bootstrap-unavailable',origin:'runtime',
    sourceVersion:installedBinding?`source:${installedBinding.sourceId}/declared-artifact:${installedBinding.declaredArtifactId}/version:${installedBinding.version}`:'unknown-installed',
    summary:installationError,evidence:{kind:'bootstrap-unavailable',installedRoot:ports.appRoot,noVerifiedCache:true}});
  throw new AggregateError(failures,'当前安装和已绑定的独立管理快照均不可用');
}
