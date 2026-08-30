import assert from 'node:assert/strict';
import test from 'node:test';
import { appDatabaseConnection, databaseConnection } from '../infrastructure/database';
import { agentCommandChains } from '../domain/agent-command-profile';
import { loadCommandChainDefinition } from '../domain/command-chain-definition';
import { activateAgentConfiguration, activeAgentConfigurationPrompt, createAgentConfiguration, listAgentConfigurations, saveActiveAgentConfigurationPrompt, saveAgentConfigurationDocument } from './agent-configurations';

test('stores multiple Agent configurations globally and loads the active YAML', async () => {
  const initial = listAgentConfigurations('backlog-agent');
  assert.equal(initial.length, 1);
  assert.equal(initial[0].active, true);
  const original = initial[0].documents[0];
  assert.equal(original.commandChainId, 'requirement-context');

  const configurationId = createAgentConfiguration({
    agentId: 'backlog-agent',
    name: '严格验收配置',
    fromConfigurationId: initial[0].configurationId,
  });
  const yaml = original.yaml.replace(
    'version: 1',
    'version: 1\n# global-agent-configuration-test',
  );
  saveAgentConfigurationDocument({
    agentId: 'backlog-agent',
    configurationId,
    commandChainId: 'requirement-context',
    yaml,
  });
  activateAgentConfiguration({ agentId: 'backlog-agent', configurationId });
  const promptRevision = activeAgentConfigurationPrompt('backlog-agent').revision;
  saveActiveAgentConfigurationPrompt({ agentId: 'backlog-agent', content: '# 全局严格验收 Prompt' });

  const configurations = listAgentConfigurations('backlog-agent');
  assert.equal(configurations.length, 2);
  assert.equal(configurations.find((item) => item.active)?.name, '严格验收配置');
  assert.match(configurations.find((item) => item.active)!.documents[0].yaml, /global-agent-configuration-test/);
  assert.equal(loadCommandChainDefinition('requirement-context').agent, 'backlog-agent');
  assert.equal(activeAgentConfigurationPrompt('backlog-agent').content, '# 全局严格验收 Prompt');
  assert.equal(activeAgentConfigurationPrompt('backlog-agent').revision, promptRevision + 1);

  const appRow = appDatabaseConnection().prepare(`
    SELECT COUNT(*) AS count FROM agent_configuration_sets WHERE agent_id = 'backlog-agent'
  `).get() as { count: number };
  assert.equal(appRow.count, 2);
  const projectDb = await databaseConnection();
  const projectTable = projectDb.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_configuration_sets'
  `).get();
  assert.equal(projectTable, undefined);
});

test('reports an invalid active YAML without crashing the Agent configuration page projection', () => {
  const active = listAgentConfigurations('backlog-agent').find((configuration) => configuration.active)!;
  const document = active.documents.find((item) => item.commandChainId === 'requirement-context')!;
  const invalidYaml = document.yaml.replace('    title: 业务变化上下文\n', '');
  assert.notEqual(invalidYaml, document.yaml);
  appDatabaseConnection().prepare(`
    UPDATE agent_configuration_documents
    SET yaml_content = ?, content_hash = 'invalid-test-fixture'
    WHERE configuration_id = ? AND command_chain_id = 'requirement-context'
  `).run(invalidYaml, active.configurationId);

  const invalidDocument = listAgentConfigurations('backlog-agent')
    .find((configuration) => configuration.active)!.documents[0];
  assert.match(invalidDocument.validationError || '', /artifacts\.requirement-context\.title/);
  const [projected] = agentCommandChains('backlog-agent');
  assert.equal(projected.phases.length, 0);
  assert.match(projected.configurationError || '', /artifacts\.requirement-context\.title/);
  assert.throws(() => loadCommandChainDefinition('requirement-context'), /artifacts\.requirement-context\.title/);

  saveAgentConfigurationDocument({
    agentId: 'backlog-agent',
    configurationId: active.configurationId,
    commandChainId: 'requirement-context',
    yaml: document.yaml,
  });
});
