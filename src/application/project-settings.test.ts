import assert from 'node:assert/strict';
import test from 'node:test';

test('inherits the project flow runtime by default and preserves explicit agent overrides', async () => {
  const { FLOW_AGENT_IDS } = await import('../domain/agent-profile');
  const {
    agentExecutionOptions,
    getFlowAgentDefaultRuntimeSettings,
    getAgentRuntimeSettings,
    listAgentRuntimeSettings,
    setFlowAgentDefaultRuntimeSettings,
    setAgentRuntimeSettings,
  } = await import('./project-settings');
  const defaultsBefore = await getFlowAgentDefaultRuntimeSettings();
  const backlogBefore = await getAgentRuntimeSettings('backlog-agent');
  const devBefore = await getAgentRuntimeSettings('dev-agent');
  const specBefore = await getAgentRuntimeSettings('requirement-spec-agent');

  async function restoreAgent(agentId: 'backlog-agent' | 'dev-agent' | 'requirement-spec-agent', previous: typeof backlogBefore) {
    await setAgentRuntimeSettings(agentId, previous.source === 'project_default' ? {
      inheritProjectDefault: true,
    } : {
      executorId: previous.executorId,
      codexModel: previous.codexModel,
      codexReasoningEffort: previous.codexReasoningEffort,
      codexWebSearch: previous.codexWebSearch,
      claudeModel: previous.claudeModel,
      ompModel: previous.ompModel,
      ompThinking: previous.ompThinking,
    });
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
    await setAgentRuntimeSettings('backlog-agent', { inheritProjectDefault: true });
    await setAgentRuntimeSettings('dev-agent', {
      executorId: 'claude',
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'default',
      codexWebSearch: false,
      claudeModel: 'claude-sonnet-4-6',
      ompModel: '',
      ompThinking: 'default',
    });
    await setAgentRuntimeSettings('requirement-spec-agent', {
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
    assert.equal(backlog.source, 'project_default');
    assert.equal(backlog.executorId, 'codex');
    assert.deepEqual(agentExecutionOptions(backlog), { model: 'gpt-5.6-terra', reasoningEffort: 'high', webSearch: true });
    assert.equal(dev.source, 'agent_override');
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
  }
});

test('persists an optional Claude model and maps it to execution options', async () => {
  const { agentExecutionOptions, getAgentExecutorSettings, setAgentExecutorSettings } = await import('./project-settings');
  const { databaseConnection } = await import('../infrastructure/database');
  const keys = ['agent_executor', 'codex_model', 'codex_reasoning_effort', 'codex_web_search', 'claude_model', 'omp_model', 'omp_thinking'];
  const db = await databaseConnection();
  const placeholders = keys.map(() => '?').join(', ');
  const backup = db.prepare(`SELECT setting_key, setting_value FROM project_settings WHERE setting_key IN (${placeholders})`).all(...keys) as { setting_key: string; setting_value: string }[];
  const deleteSettings = db.prepare(`DELETE FROM project_settings WHERE setting_key IN (${placeholders})`);
  const restore = db.prepare(`INSERT INTO project_settings(setting_key, setting_value) VALUES(?, ?)`);

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

    const blank = await setAgentExecutorSettings({ ...settings, claudeModel: '  ' });
    assert.equal(blank.claudeModel, '');
    assert.deepEqual(agentExecutionOptions(blank), {});
  } finally {
    db.transaction(() => {
      deleteSettings.run(...keys);
      for (const row of backup) restore.run(row.setting_key, row.setting_value);
    })();
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
