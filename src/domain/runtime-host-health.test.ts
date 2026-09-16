import assert from 'node:assert/strict';
import test from 'node:test';
import {assertHeldHostHealth} from './runtime-host-health';

test('private held health requires actual version, fresh owned lease and business silence before and after activation',()=>{
  const now=Date.now();const health={version:'actual-v1',owner:true,token:3,leaseExpiresAt:new Date(now+30000).toISOString(),
    managementMode:'update-silence',businessMode:'update-silence',updatePending:true,runId:null,runPhase:'stopped',lastError:null};
  assertHeldHostHealth(health,'actual-v1',false,now);
  assertHeldHostHealth({...health,businessMode:'normal'},'actual-v1',false,now);
  assertHeldHostHealth({...health,businessMode:'normal'},'actual-v1',true,now);
  assert.throws(()=>assertHeldHostHealth(health,'actual-v1',true,now));
  for(const change of [{version:'old'},{owner:false},{token:null},{leaseExpiresAt:new Date(now).toISOString()},
    {leaseExpiresAt:'invalid'},{managementMode:'normal'},{updatePending:false},{runId:'running'},{runPhase:'crashed'},{lastError:'loader failed'}])
    assert.throws(()=>assertHeldHostHealth({...health,...change},'actual-v1',false,now));
});
