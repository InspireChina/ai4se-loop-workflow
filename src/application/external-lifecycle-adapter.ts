import type {RuntimeHostAudit} from '../domain/runtime-host-audit';
import type {ExternalRuntimeControlAction,ExternalRuntimeControlReceipt} from './external-runtime-controls';
import type {PublisherUpdate} from '../domain/runtime-update';

type Status={control:{desired_intent:'running'|'stopped';intent_revision:number;management_mode:'normal'|'update-silence';
  owner_id:string|null;fencing_token:number;expires_at:number};business?:RuntimeHostAudit;businessError?:string;publisher?:PublisherUpdate|null;installationError?:string};

/** UI-facing view of independent intent and actual read-only business facts.
 * Unknown business state is never fabricated as stopped or healthy. This
 * adapter neither opens business storage nor claims its supervision lease. */
export function externalLifecycleView(status:Status){
  const observed=status.business?.lifecycle;
  return {
    intent:{desired:status.control.desired_intent,revision:status.control.intent_revision},
    mode:status.control.management_mode==='normal'?{kind:'normal' as const}
      :{kind:'update-silence' as const,attemptId:status.publisher?.attemptId??null,targetVersion:status.publisher?.targetVersion??null,
        readiness:status.publisher?.status==='ready'?'ready':status.publisher?.status==='preparing'?'pending':null},
    run:{phase:observed?.phase??'unknown',runId:observed?.runId??null,healthy:false,health:'unverified' as const,
      startedAt:observed?.run?.startedAt??null,heartbeatAt:observed?.run?.heartbeatAt??null},
    supervision:{owner:false,token:observed?.lease?.token??null,restartCount:observed?.restartCount??0,
      retryAt:observed?.retryAt??null,leaseExpiresAt:observed?.lease?.expiresAt??null},
    management:{ownerId:status.control.owner_id,token:status.control.fencing_token,expiresAt:status.control.expires_at},
    bootstrapWarning:status.installationError??null,
    lastError:status.businessError??observed?.lastError??(status.installationError?'BOOTSTRAP_UNAVAILABLE':!observed?'BUSINESS_LIFECYCLE_UNKNOWN':null),
  };
}
export type ExternalLifecycleView=ReturnType<typeof externalLifecycleView>;

export function createExternalLifecycleAdapter(ports:{status:()=>Promise<Status>;
  command:(requestId:string,action:ExternalRuntimeControlAction)=>Promise<ExternalRuntimeControlReceipt>;
}){
  return {
    status:async()=>externalLifecycleView(await ports.status()),
    async command(input:{requestId:string;action:ExternalRuntimeControlAction;source?:unknown}){
      const receipt=await ports.command(input.requestId,input.action);
      return {...receipt,snapshot:externalLifecycleView(await ports.status()),
        error:receipt.failures.length?receipt.failures.join('; '):undefined};
    },
  };
}
