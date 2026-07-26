import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
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
    env: { ...process.env, ...agentResultChannelEnv(channel, 'dev-agent') },
  });

  assert.match(output, /submitted successfully/);
  assert.equal(existsSync(input), false);
  assert.deepEqual(JSON.parse(readAgentResultChannel(channel)!), {
    outcome: 'completed',
    summary: 'submitted by fixture',
    questions: [],
    runtimeInputs: [],
    feedbackResolutions: [],
    recoveryResolutions: [],
  });
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
    env: { ...process.env, ...agentResultChannelEnv(channel, 'dev-agent') },
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
    {
      channel: channels[0],
      result: { summary: 'no reusable learning', observations: [] },
      expected: { summary: 'no reusable learning', observations: [] },
    },
    {
      channel: channels[1],
      result: {
        outcome: 'no_issue',
        fingerprint: 'expected-no-issue',
        classification: 'expected_failure',
        summary: 'The observed behavior does not require a repair.',
        rootCause: 'The behavior matches the current contract.',
        confidence: 0.9,
      },
      expected: {
        outcome: 'no_issue',
        fingerprint: 'expected-no-issue',
        classification: 'expected_failure',
        summary: 'The observed behavior does not require a repair.',
        rootCause: 'The behavior matches the current contract.',
        confidence: 0.9,
        changedFiles: [],
        tests: [],
        followUp: '',
      },
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const input = join(inputDirectory, `result-${index}.json`);
    writeFileSync(input, JSON.stringify(fixture.result));
    execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'loop', 'submit-agent-result.mjs'), '--input', input], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: { ...process.env, ...agentResultChannelEnv(fixture.channel) },
    });
    assert.deepEqual(JSON.parse(readAgentResultChannel(fixture.channel)!), fixture.expected);
  }
});

test('returns the full contract error to the Agent and accepts a corrected resubmission', (t) => {
  const channel = createAgentResultChannel('flow');
  const inputDirectory = mkdtempSync(join(tmpdir(), 'loopwork-result-retry-'));
  const input = join(inputDirectory, 'result.json');
  t.after(() => {
    removeAgentResultChannel(channel);
    rmSync(inputDirectory, { recursive: true, force: true });
  });
  const result = {
    outcome: 'completed',
    summary: 'A complete delivery specification is ready.',
    artifact: { title: 'Analysis', content: 'Complete analysis.' },
    spec: deliverySpecFixture({
      decisions: [{
        key: 'state-shape',
        type: 'technical',
        title: 'Public state shape',
        question: 'Should the existing public state shape change?',
        impact: 'A change would affect compatibility.',
        options: [
          { id: 'keep', label: 'Keep it', consequences: ['Preserves compatibility'] },
          { id: 'change', label: 'Change it', consequences: ['Requires compatibility work'] },
        ],
        status: 'resolved',
        selectedOption: 'keep',
        authority: 'project_evidence',
        decision: 'Keep the existing state shape',
        rationale: 'The current public contract proves it',
        evidence: 'The current public interface defines the existing state shape.',
      }],
      unit: {
        ...deliverySpecFixture().unit,
        sourceRefs: [
          { key: 'acceptance:inspect', kind: 'acceptance', content: 'State is inspectable', sourceRef: 'TEST:inspect' },
          { key: 'acceptance:runtime', kind: 'acceptance', content: 'Runtime command succeeds', sourceRef: 'TEST:runtime' },
        ],
      },
      handoff: {
        implementationGuidance: 'Preserve the public state shape.',
        guardrails: [],
        verificationFocus: [
          { key: 'AC-1', expected: 'The state can be inspected', oracle: 'Inspect the state' },
          { key: 'AC-2', expected: 'The runtime command succeeds', oracle: '' },
        ],
      },
    } as never),
  };
  writeFileSync(input, JSON.stringify(result));
  const environment = { ...process.env, ...agentResultChannelEnv(channel, 'analyst-agent') };
  const rejected = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'loop', 'submit-agent-result.mjs'), '--input', input, '--consume'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /verificationFocus/);
  assert.match(rejected.stderr, /oracle/);
  assert.equal(readAgentResultChannel(channel), null);
  assert.equal(existsSync(input), true);

  result.spec.handoff.verificationFocus[1].oracle = 'Run node --version';
  writeFileSync(input, JSON.stringify(result));
  const accepted = execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'loop', 'submit-agent-result.mjs'), '--input', input, '--consume'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment,
  });
  assert.match(accepted, /submitted successfully/);
  assert.equal(existsSync(input), false);
  const submitted = JSON.parse(readAgentResultChannel(channel)!);
  assert.equal(submitted.spec.handoff.verificationFocus[0].oracle, 'Inspect the state');
  assert.equal(submitted.spec.handoff.verificationFocus[1].oracle, 'Run node --version');
});
