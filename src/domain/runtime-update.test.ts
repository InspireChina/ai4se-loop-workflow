import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';
import {runtimeActivationTarget,type RuntimeUpdateRecord} from './runtime-update';

test('held-host activation binds the historical rollback target, never the damaged original or an unrelated phase',()=>{
  const root=process.cwd();
  const artifact=(name:string,hash:string)=>({root:join(root,name),sourceId:hash.repeat(64),artifactId:hash.repeat(64),version:name});
  const before=artifact('damaged','a'),candidate=artifact('candidate','b'),historical=artifact('historical','c');
  const update:RuntimeUpdateRecord={request:{updateId:'controlled-id',caseId:'controlled-case',before,candidate},
    rollback:{artifact:historical,sourceUpdateId:'controlled-historical-startup'},phase:'known-good-activating',selected:historical,
    intentRevision:1,ownerId:'controller',token:1,expiresAt:1,failure:'original failure',createdAt:1,updatedAt:1};
  assert.deepEqual(runtimeActivationTarget(update),historical);
  assert.notDeepEqual(runtimeActivationTarget(update),before);
  assert.deepEqual(runtimeActivationTarget({...update,phase:'candidate-activating'}),candidate);
  for(const phase of ['rolling-back','known-good-starting','known-good-observing','rolled-back','aborted'] as const)assert.equal(runtimeActivationTarget({...update,phase}),null);
  assert.deepEqual(runtimeActivationTarget({...update,rollback:undefined}),before,'legacy intact-before rollback keeps its original protocol');
  assert.equal(update.failure,'original failure');assert.deepEqual(update.request.before,before);
});
