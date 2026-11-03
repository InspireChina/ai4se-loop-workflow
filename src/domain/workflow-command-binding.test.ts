import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { agentCommandProfiles } from './agent-command-profile';
import { workflowCommandBinding } from './workflow-command-binding';
import { loadExternalCommandPrompt, externalCommandOptions } from '../infrastructure/external-command-prompts';
import { loadExternalCommandChains } from '../infrastructure/external-command-chains';

test('every fixed pipeline resolves a native prompt and matching executable chain including feedback and resume', () => {
  const workspace = process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!;
  for (const profile of agentCommandProfiles()) {
    const prompt = loadExternalCommandPrompt(workspace, profile.agent);
    assert.equal(externalCommandOptions(prompt).nativeCommand?.name, profile.agent);
    assert.ok(prompt.prompt.includes(`/${profile.agent}`));
    assert.ok(prompt.prompt.includes(`.omp/commands/${profile.agent}.cjs`));
    if (profile.commandChainId) {
      assert.ok(loadExternalCommandChains(workspace, profile.agent).documents.some(document => document.commandChainId === profile.commandChainId));
    }
    for (const pipeline of [...profile.pipelines, ...(profile.supportsResume ? ['resume'] : [])]) {
      const binding = workflowCommandBinding(workspace, profile.agent, pipeline);
      assert.ok(binding.includes(`- Pipeline: ${pipeline}`));
      assert.ok(binding.includes(`- Command Chain ID: ${profile.commandChainId || 'direct'}`));
      assert.ok(binding.includes(join(workspace, '.omp', 'commands', `${profile.agent}.md`)));
      assert.ok(binding.includes(join(workspace, '.omp', 'commands', `${profile.agent}.cjs`)));
      assert.ok(binding.includes(JSON.stringify({ args: profile.draftType === 'direct' ? ['direct', 'run'] : ['status'] })));
    }
  }
  assert.throws(() => workflowCommandBinding(workspace, 'dev-agent', 'feedback-triage'), /没有 Workflow Command 绑定/);
});
