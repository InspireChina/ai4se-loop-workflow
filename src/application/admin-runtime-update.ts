import type {AdminAuthority} from '../domain/repair-case';
import type {IndependentVerificationInput} from '../domain/independent-verification-preparation';
import type {AdminManagementStore} from '../infrastructure/admin-management-store';

/** Runtime replacement belongs to the external host, not the business Runner
 * or an Agent command. Admission is not a physical handback or Case closure. */
export async function requestVerifiedRuntimeRepairUpdate(ports:{
  store:AdminManagementStore;authority:AdminAuthority;caseId:string;
  assertInput:(input:IndependentVerificationInput,assertCurrent:()=>void)=>Promise<void>;
}) {
  const target=ports.store.verifiedRuntimeUpdateInput(ports.authority,ports.caseId);
  const prior=ports.store.runtimeUpdate(target.updateId);
  if(prior)return prior;
  const assertCurrent=()=>{
    const current=ports.store.verifiedRuntimeUpdateInput(ports.authority,ports.caseId);
    if(current.verificationAttemptId!==target.verificationAttemptId||JSON.stringify(current.input)!==JSON.stringify(target.input))
      throw new Error('运行版本切换验证来源已改变');
  };
  await ports.assertInput(target.input,assertCurrent);
  assertCurrent();
  return ports.store.beginVerifiedRuntimeUpdate(ports.authority,ports.caseId,target.verificationAttemptId);
}
