import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import type {AdminControllerPorts} from '../application/admin-controller';
import {createConfiguredAdminExecution} from '../application/admin-configured-execution';
import {adminRuntimeConfigurationSchema} from '../domain/admin-runtime-configuration';
import {independentPreparationHash} from '../domain/independent-verification-preparation';
import type {AdminManagementStore} from './admin-management-store';
import {createNativeAdminBusinessWorker} from './native-admin-business-worker';
import {createAdminExecutionLauncher,confirmAdminAttemptStopped} from './admin-execution';
import {getAgentExecutor} from './agent-executor';
import {resolveAgentExecutionLimits} from './agent-execution-limits';
import {createLangfuseTelemetry} from './langfuse';
import {createDefaultRepairVerification} from './default-repair-verification';
import {createIndependentVerificationPreparation} from './independent-verification-preparation';
import {sanitizeDiagnosticText} from './diagnostic-text';
import {runtimeHostAuditSchema,type RuntimeHostAudit} from '../domain/runtime-host-audit';
import {runtimeHostHealthSchema} from '../domain/runtime-host-health';
import type {LegacyStartupHealthReader} from './native-runtime-update';
import {createManagementToolLaunch} from './management-tool-launch';
import {RuntimeCapabilityFailure} from '../domain/runtime-original-artifact';
import type {RuntimeUpdateRecord} from '../domain/runtime-update';
import {requestVerifiedRuntimeRepairUpdate} from '../application/admin-runtime-update';
import {assertRuntimeVerificationInput} from './runtime-verification-input';
import {confirmRuntimeRepairHandoff} from './runtime-repair-handoff';
import {runtimeBusinessProgressResultSchema} from '../domain/runtime-business-progress';

const configurationResponse=z.object({configuration:adminRuntimeConfigurationSchema,
  alternatives:z.array(adminRuntimeConfigurationSchema).max(1000)}).strict();
const takeoverReconciliationResponse=z.object({attemptIds:z.array(z.string().min(1)),revoked:z.number().int().nonnegative(),
  draining:z.number().int().nonnegative()}).strict();

/** Native management composition: business modules exist only in short-lived
 * fenced capability children. Cached configured choices remain independent. */
export function createNativeAdminManagement(ports:{
  store:AdminManagementStore;rootOwnerId:string;appRoot:string;dataRoot:string;executable:string;electronNode?:boolean;
  capabilityTimeoutMs?:number;confirmContainmentExit?:Parameters<typeof createNativeAdminBusinessWorker>[0]['confirmContainmentExit'];
  onError?:(error:unknown)=>void;
}):Omit<AdminControllerPorts,'store'|'ownerId'>&{inspectHosts:()=>Promise<RuntimeHostAudit>;readLegacyStartupHealth:LegacyStartupHealthReader;
  freezeRuntimeBusinessBaseline:(update:RuntimeUpdateRecord,signal:AbortSignal,check:()=>void)=>Promise<void>} {
  const worker=createNativeAdminBusinessWorker({...ports,timeoutMs:ports.capabilityTimeoutMs});
  const builds=createNativeAdminBusinessWorker({...ports,lane:'harness-build'});
  const snapshots=createNativeAdminBusinessWorker({...ports,timeoutMs:ports.capabilityTimeoutMs});
  const workspaceRoot=join(ports.dataRoot,'admin','workspace');mkdirSync(workspaceRoot,{recursive:true});
  const appRoot=()=>ports.store.runtimeInstallation()?.artifact.root??ports.appRoot;
  const refresh=async()=>configurationResponse.parse(await worker.run({operation:'configuration'}));
  const configured=(launch:Parameters<typeof createConfiguredAdminExecution>[0]['launch'])=>createConfiguredAdminExecution({
    store:ports.store,refreshRuntime:async()=>(await refresh()).configuration,
    refreshAlternatives:async()=>(await refresh()).alternatives,launch,
  });
  const tools=(launch:(toolRoot:string)=>AdminControllerPorts['launch'])=>createManagementToolLaunch({
    store:ports.store,rootOwnerId:ports.rootOwnerId,launch,
  });
  const report=(error:unknown,phase:string)=>{
    try{ports.onError?.(error);}catch{/* diagnostic sinks cannot prevent cached Admin work */}
    const control=ports.store.control();
    if(control.desired_intent!=='running'||control.management_mode!=='normal'||control.owner_id!==`${ports.rootOwnerId}:management`)return;
    const rootAuthority=ports.store.runtimeHostAuthority(ports.rootOwnerId);
    const message=sanitizeDiagnosticText(error instanceof Error?error.message:String(error));
    const source=error instanceof RuntimeCapabilityFailure?error:null;
    ports.store.observeExternalRuntimeFailure(rootAuthority,source?.intentRevision??control.intent_revision,source?source.selectionRevision:ports.store.runtimeInstallation()?.revision??null,
      {observationId:`capability:${randomUUID()}`,scope:'runtime',
      scopeKey:`business:${createHash('sha256').update(ports.dataRoot).digest('hex')}`,
      fingerprint:createHash('sha256').update(`${phase}:${message}`).digest('hex'),
      sourceVersion:source?`source:${source.artifact.sourceId}/artifact:${source.artifact.artifactId}/version:${source.artifact.version}`:
        ports.store.runtimeInstallation()?.artifact.version??ports.store.runtimeConfiguration()?.configuration.sourceVersion??'unknown',
      origin:'runtime',summary:`Independent business ${phase} failed: ${message}`,
      evidence:{phase,error:message,rootOwnerId:ports.rootOwnerId,pid:process.pid,
        ...(source?{artifact:source.artifact,selectionRevision:source.selectionRevision,intentRevision:source.intentRevision,operation:source.operation}:{} )}});
  };
  const readLegacyStartupHealth:LegacyStartupHealthReader=Object.assign(async(...[record,signal,check]:Parameters<LegacyStartupHealthReader>)=>{
    const guard=()=>{signal.throwIfAborted();check();};guard();
    const abort=()=>{void worker.stopOwned().catch(error=>{try{ports.onError?.(error);}catch{}});};
    signal.addEventListener('abort',abort,{once:true});
    try{const audit=runtimeHostAuditSchema.parse(await worker.run({operation:'host-audit',updateAllocationId:record.allocationId}));
      guard();return runtimeHostHealthSchema.parse(audit.legacyHealth);}
    finally{signal.removeEventListener('abort',abort);}
  },{stopOwned:async()=>{await worker.stopOwned();return true;}});
  return {
    freezeRuntimeBusinessBaseline:async(update,signal,check)=>{
      signal.throwIfAborted();check();
      const abort=()=>{void snapshots.stopOwned().catch(error=>{try{ports.onError?.(error);}catch{}});};
      signal.addEventListener('abort',abort,{once:true});
      try{
        await snapshots.run({operation:'runtime-business-baseline',updateId:update.request.updateId});
        signal.throwIfAborted();check();ports.store.assertRuntimeBusinessBaselineReady(update);
      }finally{signal.removeEventListener('abort',abort);}
    },
    readLegacyStartupHealth,
    inspectHosts:async()=>runtimeHostAuditSchema.parse(await worker.run({operation:'host-audit'})),
    launch:configured((configuration,...args)=>tools(toolRoot=>createAdminExecutionLauncher({store:ports.store,appRoot:appRoot(),toolRoot,
      dataRoot:ports.dataRoot,workspaceRoot,executor:getAgentExecutor(configuration.executorId),executionOptions:configuration.executionOptions,
      limits:resolveAgentExecutionLimits(),telemetry:createLangfuseTelemetry({env:{LANGFUSE_ENABLED:'false'}})}))(...args)),
    launchVerification:tools(toolRoot=>createDefaultRepairVerification({store:ports.store,appRoot:toolRoot,
      assertWorkspace:async(caseId,input)=>{await worker.run({operation:input.kind==='runtime'?'assert-runtime':'assert-workspace',caseId,inputHash:independentPreparationHash(input)});},
      prepare:configured((configuration,...args)=>tools(preparationToolRoot=>createIndependentVerificationPreparation({store:ports.store,appRoot:appRoot(),toolRoot:preparationToolRoot,
        dataRoot:ports.dataRoot,executor:getAgentExecutor(configuration.executorId),executionOptions:configuration.executionOptions,
        limits:resolveAgentExecutionLimits()}))(...args)),
    })),
    confirmStopped:attempt=>confirmAdminAttemptStopped(attempt,{dataRoot:ports.dataRoot}),
    suspendCapabilities:async()=>{const results=await Promise.allSettled([worker.suspendManagedOwned(),builds.stopOwned()]);
      if(results.some(result=>result.status==='rejected'))throw new AggregateError(results.flatMap(result=>result.status==='rejected'?[result.reason]:[]),'写能力 / 构建进程退出未确认');},
    stopCapabilities:async()=>{const results=await Promise.allSettled([worker.stopOwned(),builds.stopOwned(),snapshots.stopOwned()]);
      if(results.some(result=>result.status==='rejected'))throw new AggregateError(results.flatMap(result=>result.status==='rejected'?[result.reason]:[]),'能力 / 构建进程退出未确认');},
    prepareCapabilities:async()=>{await worker.drainPrevious();await builds.drainPrevious();await snapshots.drainPrevious();},onError:ports.onError,
    discover:async()=>{
      try{
        const {configuration,alternatives}=await refresh();const control=ports.store.control();
        const authority={ownerId:`${ports.rootOwnerId}:management`,token:control.fencing_token};
        ports.store.assertManagementAuthority(authority);
        ports.store.cacheRuntimeConfiguration(authority,configuration,ports.store.runtimeConfiguration()?.revision??0);
        ports.store.cacheRuntimeAlternatives(authority,alternatives,ports.store.runtimeAlternatives()?.revision??0);
      }catch(error){report(error,'configuration');}
      try{return await worker.run({operation:'discover'});}catch(error){report(error,'discovery');return 0;}
    },
    reconcileTakeovers:async authority=>{
      ports.store.assertManagementAuthority(authority);
      return takeoverReconciliationResponse.parse(await worker.run({operation:'reconcile-takeovers'}));
    },
    manageActions:async authority=>{
      // Native source preparation must run even when selected business code
      // cannot load. It uses the stable root-bound capability image.
      if(ports.store.pendingCommandActions(authority).some(request=>request.action.kind==='harness-workspace'))await worker.run({operation:'harness-actions'});
      if(ports.store.pendingCommandActions(authority).some(request=>request.action.kind==='harness-build'))await builds.run({operation:'harness-build'});
      return worker.run({operation:'actions'});
    },
    manageFollowups:async authority=>{
      for(const repairCase of ports.store.observingCases(authority)) {
        if(repairCase.scope!=='runtime')continue;
        try {
          const update=await requestVerifiedRuntimeRepairUpdate({store:ports.store,authority,caseId:repairCase.caseId,
            assertInput:(input,assertCurrent)=>assertRuntimeVerificationInput(input,{store:ports.store,caseId:repairCase.caseId,
              dataRoot:ports.dataRoot,assertCurrent,signal:AbortSignal.timeout(60000)})});
          if(!['succeeded','rolled-back','aborted'].includes(update.phase))return update;
          if(update.phase!=='succeeded') {
            const target=ports.store.verifiedRuntimeUpdateInput(authority,repairCase.caseId);
            ports.store.recordUnappliedRuntimeRepairUpdate(authority,repairCase.caseId,target.verificationAttemptId);
          } else {
            let handedBack=false;
            try {handedBack=Boolean(await confirmRuntimeRepairHandoff({store:ports.store,authority,caseId:repairCase.caseId,dataRoot:ports.dataRoot,
              signal:AbortSignal.timeout(60000)}));}
            catch(error) {
              const target=ports.store.verifiedRuntimeUpdateInput(authority,repairCase.caseId);
              ports.store.recordRuntimeHandoffFailure(authority,repairCase.caseId,target.verificationAttemptId,
                sanitizeDiagnosticText(error instanceof Error?error.message:String(error)));
              throw error;
            }
            if(handedBack){
              try {runtimeBusinessProgressResultSchema.parse(await worker.run({operation:'runtime-business-progress',caseId:repairCase.caseId}));}
              catch(error){
                const target=ports.store.verifiedRuntimeUpdateInput(authority,repairCase.caseId);
                ports.store.recordRuntimeBusinessProgressFailure(authority,repairCase.caseId,target.verificationAttemptId,
                  sanitizeDiagnosticText(error instanceof Error?error.message:String(error)));
                throw error;
              }
            }
          }
        } catch(error) {try{ports.onError?.(error);}catch{/* One runtime Case cannot suppress independent business followups. */}}
      }
      return worker.run({operation:'followups'});
    },
  };
}
