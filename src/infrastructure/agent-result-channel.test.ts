import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentResultChannelEnv, createAgentResultChannel, readAgentResultChannel, removeAgentResultChannel } from './agent-result-channel';

test('submits one Agent result through the execution-scoped CLI channel', (t) => {
  const channel = createAgentResultChannel('flow');
  const inputDirectory = mkdtempSync(join(tmpdir(), 'loopwork-result-input-'));
  const input = join(inputDirectory, 'result.json');
  t.after(() => {
    removeAgentResultChannel(channel);
    rmSync(inputDirectory, { recursive: true, force: true });
  });
  writeFileSync(input, JSON.stringify({ outcome: 'completed', summary: 'submitted by fixture' }));

  const output = execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'loop', 'submit-agent-result.mjs'), '--input', input, '--consume'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...agentResultChannelEnv(channel) },
  });

  assert.match(output, /submitted successfully/);
  assert.equal(existsSync(input), false);
  assert.deepEqual(JSON.parse(readAgentResultChannel(channel)!), { outcome: 'completed', summary: 'submitted by fixture' });
});

test('rejects invalid CLI submissions without publishing a result', (t) => {
  const channel = createAgentResultChannel('flow');
  const inputDirectory = mkdtempSync(join(tmpdir(), 'loopwork-result-input-'));
  const input = join(inputDirectory, 'result.json');
  t.after(() => {
    removeAgentResultChannel(channel);
    rmSync(inputDirectory, { recursive: true, force: true });
  });
  writeFileSync(input, JSON.stringify({ outcome: 'done', summary: '' }));

  assert.throws(() => execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'loop', 'submit-agent-result.mjs'), '--input', input], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: { ...process.env, ...agentResultChannelEnv(channel) },
  }));
  assert.equal(readAgentResultChannel(channel), null);
  assert.equal(existsSync(input), true);
});

test('accepts the Evolution and Maintenance result kinds through the same CLI', (t) => {
  const inputDirectory = mkdtempSync(join(tmpdir(), 'loopwork-result-kinds-'));
  const channels = [createAgentResultChannel('evolution'), createAgentResultChannel('maintenance')];
  t.after(() => {
    for (const channel of channels) removeAgentResultChannel(channel);
    rmSync(inputDirectory, { recursive: true, force: true });
  });
  const fixtures = [
    { channel: channels[0], result: { summary: 'no reusable learning', observations: [] } },
    { channel: channels[1], result: { outcome: 'no_issue', summary: 'expected behavior' } },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const input = join(inputDirectory, `result-${index}.json`);
    writeFileSync(input, JSON.stringify(fixture.result));
    execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'loop', 'submit-agent-result.mjs'), '--input', input], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: { ...process.env, ...agentResultChannelEnv(fixture.channel) },
    });
    assert.deepEqual(JSON.parse(readAgentResultChannel(fixture.channel)!), fixture.result);
  }
});
