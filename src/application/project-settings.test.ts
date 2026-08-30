import assert from 'node:assert/strict';
import test from 'node:test';

test('persists and validates the global Agent concurrency limit', async () => {
  const {
    getAgentConcurrency,
    setAgentConcurrency,
  } = await import('./project-settings');
  const previous = await getAgentConcurrency();
  try {
    assert.equal(await setAgentConcurrency('7'), 7);
    assert.equal(await getAgentConcurrency(), 7);
    await assert.rejects(() => setAgentConcurrency('0'), /不能小于 1/);
    await assert.rejects(() => setAgentConcurrency('33'), /不能大于 32/);
    await assert.rejects(() => setAgentConcurrency('1.5'), /必须是整数/);
    assert.equal(await getAgentConcurrency(), 7);
  } finally {
    await setAgentConcurrency(previous);
  }
});

test('inherits the global flow runtime by default and preserves explicit agent configurations', async () => {
  const { FLOW_AGENT_IDS } = await import('../domain/agent-profile');
  const {
    activateAgentRuntimeConfiguration,
    agentExecutionOptions,
    createAgentRuntimeConfiguration,
    deleteAgentRuntimeConfiguration,
    getFlowAgentDefaultRuntimeSettings,
    getAgentRuntimeSettings,
    inheritFlowRuntimeConfiguration,
    listAgentRuntimeSettings,
    saveAgentRuntimeConfiguration,
    setFlowAgentDefaultRuntimeSettings,
  } = await import('./project-settings');
  const defaultsBefore = await getFlowAgentDefaultRuntimeSettings();
  const backlogBefore = await getAgentRuntimeSettings('backlog-agent');
  const devBefore = await getAgentRuntimeSettings('dev-agent');
  const specBefore = await getAgentRuntimeSettings('requirement-spec-agent');

  const created: Array<{ agentId: 'dev-agent' | 'requirement-spec-agent'; configurationId: string }> = [];

  async function createOverride(
    agentId: 'dev-agent' | 'requirement-spec-agent',
    name: string,
    settings: Omit<Parameters<typeof saveAgentRuntimeConfiguration>[0], 'agentId' | 'configurationId' | 'name'>,
  ) {
    const configurationId = await createAgentRuntimeConfiguration({ agentId, name });
    created.push({ agentId, configurationId });
    await saveAgentRuntimeConfiguration({ ...settings, agentId, configurationId, name });
    await activateAgentRuntimeConfiguration({ agentId, configurationId });
  }

  async function restoreAgent(agentId: 'backlog-agent' | 'dev-agent' | 'requirement-spec-agent', previous: typeof backlogBefore) {
    await inheritFlowRuntimeConfiguration(agentId);
    if (previous.source === 'agent_configuration') {
      await activateAgentRuntimeConfiguration({ agentId, configurationId: previous.configurationId });
    }
  }

  try {
    await setFlowAgentDefaultRuntimeSettings({
      executorId: 'codex',
      codexModel: 'gpt-5.6-terra',
      codexReasoningEffort: 'high',
      codexWebSearch: true,
      claudeModel: '',
      ompModel: '',
      ompThinking: 'default',
    });
    await inheritFlowRuntimeConfiguration('backlog-agent');
    await createOverride('dev-agent', '测试 Claude Runtime', {
      executorId: 'claude',
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'default',
      codexWebSearch: false,
      claudeModel: 'claude-sonnet-4-6',
      ompModel: '',
      ompThinking: 'default',
    });
    await createOverride('requirement-spec-agent', '测试 OMP Runtime', {
      executorId: 'omp',
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'xhigh',
      codexWebSearch: true,
      claudeModel: '',
      ompModel: 'ollama/qwen3.6:35b',
      ompThinking: 'high',
    });

    const backlog = await getAgentRuntimeSettings('backlog-agent');
    const dev = await getAgentRuntimeSettings('dev-agent');
    assert.equal(backlog.source, 'global_default');
    assert.equal(backlog.executorId, 'codex');
    assert.deepEqual(agentExecutionOptions(backlog), { model: 'gpt-5.6-terra', reasoningEffort: 'high', webSearch: true });
    assert.equal(dev.source, 'agent_configuration');
    assert.equal(dev.executorId, 'claude');
    assert.deepEqual(agentExecutionOptions(dev), { model: 'claude-sonnet-4-6' });
    const spec = await getAgentRuntimeSettings('requirement-spec-agent');
    assert.equal(spec.executorId, 'omp');
    assert.deepEqual(agentExecutionOptions(spec), { model: 'ollama/qwen3.6:35b', reasoningEffort: 'high' });

    await setFlowAgentDefaultRuntimeSettings({
      executorId: 'cursor',
      codexModel: 'gpt-5.6-luna',
      codexReasoningEffort: 'low',
      codexWebSearch: false,
      claudeModel: '',
      ompModel: '',
      ompThinking: 'default',
    });
    assert.equal((await getAgentRuntimeSettings('backlog-agent')).executorId, 'cursor');
    assert.equal((await getAgentRuntimeSettings('dev-agent')).executorId, 'claude');
    assert.equal((await listAgentRuntimeSettings()).length, FLOW_AGENT_IDS.length);
    await assert.rejects(() => getAgentRuntimeSettings('unknown-agent'), /未知 Agent/);
  } finally {
    await setFlowAgentDefaultRuntimeSettings(defaultsBefore);
    await restoreAgent('backlog-agent', backlogBefore);
    await restoreAgent('dev-agent', devBefore);
    await restoreAgent('requirement-spec-agent', specBefore);
    for (const item of created) await deleteAgentRuntimeConfiguration(item);
  }
});

test('stores system Runtime outside project settings and maps it to execution options', async () => {
  const { agentExecutionOptions, getAgentExecutorSettings, setAgentExecutorSettings } = await import('./project-settings');
  const { databaseConnection } = await import('../infrastructure/database');
  const previous = await getAgentExecutorSettings();
  const db = await databaseConnection();
  const legacy = db.prepare("SELECT setting_value FROM project_settings WHERE setting_key = 'agent_executor'").get() as { setting_value: string } | undefined;

  try {
    await setAgentExecutorSettings({
      executorId: 'claude',
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'default',
      codexWebSearch: true,
      claudeModel: 'claude-sonnet-4-6',
      ompModel: '',
      ompThinking: 'default',
    });
    const settings = await getAgentExecutorSettings();
    assert.equal(settings.claudeModel, 'claude-sonnet-4-6');
    assert.equal(settings.codexWebSearch, true);
    assert.deepEqual(agentExecutionOptions(settings), { model: 'claude-sonnet-4-6' });

    db.prepare(`
      INSERT INTO project_settings(setting_key, setting_value) VALUES('agent_executor', 'cursor')
      ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
    `).run();
    assert.equal((await getAgentExecutorSettings()).executorId, 'claude');

    const blank = await setAgentExecutorSettings({ ...settings, claudeModel: '  ' });
    assert.equal(blank.claudeModel, '');
    assert.deepEqual(agentExecutionOptions(blank), {});
  } finally {
    await setAgentExecutorSettings(previous);
    if (legacy) {
      db.prepare(`
        INSERT INTO project_settings(setting_key, setting_value) VALUES('agent_executor', ?)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
      `).run(legacy.setting_value);
    } else db.prepare("DELETE FROM project_settings WHERE setting_key = 'agent_executor'").run();
  }
});

test('saves, activates, switches, and deletes named Agent Runtime configurations', async () => {
  const {
    activateAgentRuntimeConfiguration,
    createAgentRuntimeConfiguration,
    deleteAgentRuntimeConfiguration,
    getAgentRuntimeSettings,
    inheritFlowRuntimeConfiguration,
    listAgentRuntimeConfigurations,
    saveAgentRuntimeConfiguration,
  } = await import('./project-settings');
  const agentId = 'test-agent';
  const previous = await getAgentRuntimeSettings(agentId);
  let firstId = '';
  let secondId = '';
  try {
    firstId = await createAgentRuntimeConfiguration({ agentId, name: '快速配置 A' });
    secondId = await createAgentRuntimeConfiguration({ agentId, name: '快速配置 B', fromConfigurationId: firstId });
    await saveAgentRuntimeConfiguration({
      agentId,
      configurationId: firstId,
      name: '快速配置 A',
      executorId: 'omp',
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'default',
      codexWebSearch: false,
      claudeModel: '',
      ompModel: 'ollama/qwen3.6:35b',
      ompThinking: 'high',
    });
    await activateAgentRuntimeConfiguration({ agentId, configurationId: firstId });
    assert.equal((await getAgentRuntimeSettings(agentId)).configurationName, '快速配置 A');
    assert.equal((await getAgentRuntimeSettings(agentId)).executorId, 'omp');

    await activateAgentRuntimeConfiguration({ agentId, configurationId: secondId });
    assert.equal((await getAgentRuntimeSettings(agentId)).configurationName, '快速配置 B');
    await deleteAgentRuntimeConfiguration({ agentId, configurationId: firstId });
    firstId = '';

    await inheritFlowRuntimeConfiguration(agentId);
    assert.equal((await getAgentRuntimeSettings(agentId)).source, 'global_default');
    assert.equal(listAgentRuntimeConfigurations(agentId).length >= 1, true);
  } finally {
    await inheritFlowRuntimeConfiguration(agentId);
    for (const configurationId of [firstId, secondId].filter(Boolean)) {
      await deleteAgentRuntimeConfiguration({ agentId, configurationId });
    }
    if (previous.source === 'agent_configuration') {
      await activateAgentRuntimeConfiguration({ agentId, configurationId: previous.configurationId });
    }
  }
});

test('saves Langfuse settings without exposing the secret and builds runner env', async () => {
  const { getLangfuseRuntimeEnv, getLangfuseSettings, setLangfuseSettings } = await import('./project-settings');
  const { databaseConnection } = await import('../infrastructure/database');
  const keys = ['langfuse_enabled', 'langfuse_public_key', 'langfuse_secret_key', 'langfuse_base_url', 'langfuse_sample_rate', 'langfuse_capture_prompts'];
  const db = await databaseConnection();
  const placeholders = keys.map(() => '?').join(', ');
  const backup = db.prepare(`SELECT setting_key, setting_value FROM project_settings WHERE setting_key IN (${placeholders})`).all(...keys) as { setting_key: string; setting_value: string }[];
  const deleteSettings = db.prepare(`DELETE FROM project_settings WHERE setting_key IN (${placeholders})`);
  const restore = db.prepare(`INSERT INTO project_settings(setting_key, setting_value) VALUES(?, ?)`);

  try {
    await setLangfuseSettings({
      enabled: 'on',
      publicKey: 'pk-test-project',
      secretKey: 'sk-test-project',
      baseUrl: 'https://cloud.langfuse.com',
      sampleRate: '0.5',
      capturePrompts: 'on',
    });

    const saved = await getLangfuseSettings();
    assert.equal(saved.status, 'enabled');
    assert.equal(saved.source, 'project');
    assert.equal(saved.publicKey, 'pk-test-project');
    assert.equal(saved.hasSecretKey, true);
    assert.equal(saved.sampleRate, 0.5);
    assert.equal(saved.capturePrompts, true);
    assert.ok(!('secretKey' in saved));

    await setLangfuseSettings({
      enabled: 'on',
      publicKey: 'pk-test-project-2',
      secretKey: '',
      baseUrl: 'https://cloud.langfuse.com',
      sampleRate: '1',
      capturePrompts: null,
    });

    const runtimeEnv = await getLangfuseRuntimeEnv();
    assert.equal(runtimeEnv.LANGFUSE_ENABLED, 'true');
    assert.equal(runtimeEnv.LANGFUSE_PUBLIC_KEY, 'pk-test-project-2');
    assert.equal(runtimeEnv.LANGFUSE_SECRET_KEY, 'sk-test-project');
    assert.equal(runtimeEnv.LANGFUSE_BASE_URL, 'https://cloud.langfuse.com');
    assert.equal(runtimeEnv.LANGFUSE_SAMPLE_RATE, '1');
    assert.equal(runtimeEnv.LANGFUSE_CAPTURE_PROMPTS, 'false');
  } finally {
    db.transaction(() => {
      deleteSettings.run(...keys);
      for (const row of backup) restore.run(row.setting_key, row.setting_value);
    })();
  }
});
