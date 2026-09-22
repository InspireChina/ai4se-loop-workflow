import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOW_AGENT_IDS } from './agent-profile';
import { INTERNAL_AGENT_DEFINITIONS } from './internal-agent-catalog';

test('v0.1 internal Agent catalog is complete, uniquely identified and read-only', () => {
  assert.deepEqual(INTERNAL_AGENT_DEFINITIONS.map((agent) => agent.id), [
    'system-assistance-agent',
    'prompt-evolution-agent',
    'context-chat-agent',
    'agent-configuration-assistant',
  ]);
  assert.equal(new Set(INTERNAL_AGENT_DEFINITIONS.map((agent) => agent.id)).size, INTERNAL_AGENT_DEFINITIONS.length);
  assert.ok(INTERNAL_AGENT_DEFINITIONS.every((agent) => agent.editable === false));
  assert.ok(INTERNAL_AGENT_DEFINITIONS.every((agent) => agent.label.trim()
    && agent.description.trim()
    && agent.runtimeIdentity.trim()
    && agent.trigger.trim()
    && agent.authority.trim()));
  assert.deepEqual(INTERNAL_AGENT_DEFINITIONS
    .map((agent) => agent.id)
    .filter((id) => (FLOW_AGENT_IDS as readonly string[]).includes(id)), []);
});
