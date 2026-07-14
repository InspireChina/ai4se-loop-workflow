import assert from 'node:assert/strict';
import test from 'node:test';

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
