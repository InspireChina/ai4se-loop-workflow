import {runtimeArtifactSchema,type RuntimeArtifact} from './runtime-update';

type SourceEquivalence = {
  installedRoot:string;sourceId:string;version:string;buildId:string;declaredArtifactId:string;archiveHash:string;
  sourceArtifactId:string;sourceBuildId:string;
};

function sourceEquivalence(value:unknown):SourceEquivalence|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const raw=value as Record<string,unknown>;
  const keys=['installedRoot','sourceId','version','buildId','declaredArtifactId','archiveHash','sourceArtifactId','sourceBuildId'];
  if(Object.keys(raw).sort().join(',')!==[...keys].sort().join(',')||keys.some(key=>typeof raw[key]!=='string'||!(raw[key] as string).trim()))return null;
  if(!/^[a-f0-9]{64}$/.test(String(raw.declaredArtifactId))||!/^[a-f0-9]{64}$/.test(String(raw.archiveHash))
    ||!/^[a-f0-9]{64}$/.test(String(raw.sourceArtifactId)))return null;
  return raw as SourceEquivalence;
}

/** Read only the original persisted failure identity. Never substitute a
 * current installation or an unrelated healthy management bootstrap for old
 * evidence. A damaged install may use an independently verified source
 * artifact only when the native bootstrap persisted an exact source/version
 * equivalence proof. This grants source restoration, never runtime health. */
export function originalRuntimeArtifact(evidence:Record<string,unknown>):RuntimeArtifact {
  const current=evidence.artifact===undefined?null:runtimeArtifactSchema.parse(evidence.artifact);
  const legacy=evidence.attemptedArtifact===undefined?null:runtimeArtifactSchema.parse(evidence.attemptedArtifact);
  if(current&&legacy&&JSON.stringify(current)!==JSON.stringify(legacy))throw new Error('原始 runtime artifact 来源冲突');
  const source=evidence.sourceArtifact===undefined?null:runtimeArtifactSchema.parse(evidence.sourceArtifact);
  const equivalence=sourceEquivalence(evidence.sourceEquivalence);
  if(source&&(!equivalence||equivalence.sourceId!==source.sourceId||equivalence.version!==source.version
    ||equivalence.sourceArtifactId!==source.artifactId))throw new Error('损坏 runtime 的独立源码等价证明无效');
  const artifact=current??legacy??source;
  if(!artifact)throw new Error('原始 runtime 故障缺少准确 artifact 来源');
  if(source&&artifact!==source&&(source.sourceId!==artifact.sourceId||source.version!==artifact.version))throw new Error('原始 runtime 源码来源冲突');
  return artifact;
}

/** Capture at capability admission, not after an asynchronous failure when
 * a successor may have selected another installation. Cleanup keeps its
 * original barrier semantics; the cause remains available for diagnosis. */
export class RuntimeCapabilityFailure extends Error {
  constructor(cause:unknown,readonly artifact:RuntimeArtifact,readonly selectionRevision:number|null,readonly operation:string,readonly intentRevision:number){
    super(cause instanceof Error?cause.message:String(cause),{cause});this.name='RuntimeCapabilityFailure';
  }
}
