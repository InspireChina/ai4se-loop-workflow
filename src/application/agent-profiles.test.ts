import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { databaseConnection, paths } from '../infrastructure/database';

test('promotes one Daily Memory observation into Durable Memory idempotently', async () => {
  const {
    agentProfileInternals,
    ensureAgentRuntimeWorkspace,
    getAgentProfile,
    promoteDailyMemoryObservation,
  } = await import('./agent-profiles');
  await ensureAgentRuntimeWorkspace();
  const agentId = 'repro-agent';
  const initial = await getAgentProfile(agentId, false);
  const projectId = initial.project.project_id;
  const memoryName = '2099-12-31.md';
  const dailyContent = [
    '# 2099-12-31',
    '',
    '<!-- execution:EXEC-daily-promote-1 fingerprint:verify-reproduction-input -->',
    '## 复现前先核对冻结输入可以减少无效尝试',
    '',
    '- Fingerprint: `verify-reproduction-input`',
    '- Category: verification',
    '- Target: daily',
    '- Confidence: 0.88',
    '- Guidance: 复现前先逐项核对冻结输入、运行条件和预期偏差，再开始执行复现步骤。',
    '- Evidence: execution `EXEC-daily-promote-1`',
    '',
    '<!-- execution:EXEC-daily-promote-2 fingerprint:preserve-failure-evidence -->',
    '## 保留失败证据可以帮助后续定位',
    '',
    '- Fingerprint: `preserve-failure-evidence`',
    '- Category: output-contract',
    '- Target: daily',
    '- Confidence: 0.80',
    '- Guidance: 复现失败时保留命令、退出码和关键错误输出，不要只记录笼统结论。',
    '- Evidence: execution `EXEC-daily-promote-2`',
    '',
  ].join('\n');
  agentProfileInternals.atomicWrite(
    join(agentProfileInternals.agentDirectory(projectId, agentId), 'memory', memoryName),
    dailyContent,
  );

  const before = await getAgentProfile(agentId, false);
  const daily = before.dailyMemories.find((memory) => memory.name === memoryName);
  assert.equal(daily?.observations.length, 2);
  assert.equal(daily?.observations[0].promoted, false);
  const revision = await promoteDailyMemoryObservation({
    agentId,
    memoryName,
    executionId: 'EXEC-daily-promote-1',
    fingerprint: 'verify-reproduction-input',
  });

  const promoted = await getAgentProfile(agentId, false);
  assert.equal(revision, before.currentMemory.revision + 1);
  assert.match(promoted.currentMemory.content, /<!-- EVOLUTION:verify-reproduction-input -->/);
  assert.match(promoted.currentMemory.content, /复现前先逐项核对冻结输入/);
  assert.equal(promoted.dailyMemories.find((memory) => memory.name === memoryName)?.observations[0].promoted, true);
  assert.equal(promoted.dailyMemories.find((memory) => memory.name === memoryName)?.observations[1].promoted, false);

  assert.equal(await promoteDailyMemoryObservation({
    agentId,
    memoryName,
    executionId: 'EXEC-daily-promote-1',
    fingerprint: 'verify-reproduction-input',
  }), revision);
  assert.equal((await getAgentProfile(agentId, false)).currentMemory.revision, revision);
  await assert.rejects(
    promoteDailyMemoryObservation({
      agentId,
      memoryName,
      executionId: 'EXEC-not-present',
      fingerprint: 'preserve-failure-evidence',
    }),
    /不存在该观察/,
  );

  const { POST } = await import('../../app/agents/[agentId]/memory/promote/route');
  const formData = new FormData();
  formData.set('projectId', projectId);
  formData.set('memoryName', memoryName);
  formData.set('executionId', 'EXEC-daily-promote-2');
  formData.set('fingerprint', 'preserve-failure-evidence');
  const response = await POST(new Request('http://localhost/agents/repro-agent/memory/promote', {
    method: 'POST',
    headers: { origin: 'http://localhost' },
    body: formData,
  }), { params: Promise.resolve({ agentId }) });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location') || '', /memoryPromoted=1/);
  assert.match((await getAgentProfile(agentId, false)).currentMemory.content, /<!-- EVOLUTION:preserve-failure-evidence -->/);

  const crossOriginResponse = await POST(new Request('http://localhost/agents/repro-agent/memory/promote', {
    method: 'POST',
    headers: { origin: 'https://example.com' },
    body: formData,
  }), { params: Promise.resolve({ agentId }) });
  assert.equal(crossOriginResponse.status, 403);
});

test('copies Daily Memory files from the imported project database directory', async () => {
  const { agentProfileInternals, ensureAgentRuntimeWorkspace, getAgentProfile } = await import('./agent-profiles');
  await ensureAgentRuntimeWorkspace();
  const profile = await getAgentProfile('dev-agent', false);
  const projectId = profile.project.project_id;
  const sourceDbPath = join(paths.dataRoot, 'abcdef123456', 'loop-ui.db');
  const sourceMemory = join(paths.dataRoot, 'abcdef123456', 'agent-runtime', 'agents', 'dev-agent', 'memory');
  mkdirSync(sourceMemory, { recursive: true });
  writeFileSync(join(sourceMemory, '2098-01-02.md'), '# imported daily memory\n', 'utf8');
  const db = await databaseConnection();
  db.prepare(`
    INSERT OR REPLACE INTO legacy_project_database_imports(source_db_path, workspace_root, project_id)
    VALUES(?, ?, ?)
  `).run(sourceDbPath, profile.project.workspace_root, projectId);

  await ensureAgentRuntimeWorkspace();
  const destination = join(agentProfileInternals.agentDirectory(projectId, 'dev-agent'), 'memory', '2098-01-02.md');
  assert.equal(readFileSync(destination, 'utf8'), '# imported daily memory\n');
});
