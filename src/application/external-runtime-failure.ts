import {createHash,randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import type {ExternalRuntimeFailure} from './external-runtime-host';
import type {AdminManagementStore} from '../infrastructure/admin-management-store';
import {sanitizeDiagnosticText} from '../infrastructure/diagnostic-text';

function errorDetails(value:unknown,seen=new Set<unknown>()):Record<string,unknown> {
  if(seen.has(value)||seen.size>=8)return {truncated:true,reason:'error detail depth/repetition limit'};
  seen.add(value);
  if(value instanceof Error) {
    const result:Record<string,unknown>={name:sanitizeDiagnosticText(value.name,200),message:sanitizeDiagnosticText(value.message,14000),
      stack:sanitizeDiagnosticText(value.stack||'',16000)};
    if('code' in value)result.code=sanitizeDiagnosticText(value.code,1000);
    if(value.cause!==undefined)result.cause=errorDetails(value.cause,seen);
    if(value instanceof AggregateError){result.errors=value.errors.slice(0,4).map(error=>errorDetails(error,seen));result.errorsTotal=value.errors.length;result.errorsTruncated=value.errors.length>4;}
    return result;
  }
  let text:string;try{text=typeof value==='string'?value:JSON.stringify(value)||String(value);}catch{text=String(value);}
  return {message:sanitizeDiagnosticText(text,14000)};
}

/** Persist startup facts in management storage, never initialize business
 * data. Different causes/versions stay in the same root-startup investigation
 * so a new PID/message cannot erase its previous repair history. */
export function createExternalRuntimeFailureReporter(store:AdminManagementStore,ownerId:string) {
  const scopeKey=`external-root:${createHash('sha256').update(realpathSync(store.filename)).digest('hex')}`;
  return (failure:ExternalRuntimeFailure)=>{
    const details=errorDetails(failure.error);const message=String(details.message||'Unknown external runtime failure');
    const artifact=failure.artifact;
    const processes=store.runtimeHostProcesses().filter(row=>row.authority.ownerId===failure.authority.ownerId&&row.authority.token===failure.authority.token);
    return store.observeExternalRuntimeFailure(failure.authority,failure.intentRevision,failure.selectionRevision,
      {observationId:`external-startup:${randomUUID()}`,scope:'runtime',scopeKey,fingerprint:'ordinary-host-startup',
      origin:'runtime',sourceVersion:`${failure.stage==='startup'?'':'unverified-attempt:'}source:${artifact.sourceId}/artifact:${artifact.artifactId}/version:${artifact.version}`,
      summary:`External ordinary host ${failure.stage} failed: ${message}`,
      evidence:{kind:'external-host-startup-failed',stage:failure.stage,artifact,attemptedArtifact:artifact,artifactIdentityVerified:failure.stage==='startup',
        selectionRevision:failure.selectionRevision,intentRevision:failure.intentRevision,
        host:{ownerId,authority:failure.authority,pid:process.pid},
        error:details,
        processes:processes.slice(-16),processesTotal:processes.length,processesTruncated:processes.length>16,
      }});
  };
}
