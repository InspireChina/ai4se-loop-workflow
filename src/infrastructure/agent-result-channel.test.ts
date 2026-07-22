import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
    summary: 'A complete Slice Spec is ready.',
    artifact: { title: 'Analysis', content: 'Complete analysis.' },
    spec: {
      goal: 'Define one objectively verifiable behavior.',
      scope: { included: ['One behavior'], excluded: [] },
      behaviors: [{ scenario: 'The behavior runs', expected: 'The expected result is visible' }],
      decisions: [{ key: 'state-shape', decision: 'Keep the existing state shape', rationale: 'The current public contract proves it', source: 'code' }],
      decisionTree: [{
        key: 'state-shape',
        question: 'Should the existing public state shape change?',
        impact: 'A change would affect compatibility.',
        options: [
          { id: 'keep', label: 'Keep it', consequences: ['Preserves compatibility'] },
          { id: 'change', label: 'Change it', consequences: ['Requires compatibility work'] },
        ],
        status: 'resolved_from_context',
        selectedOption: 'keep',
        source: 'code',
        evidence: ['The current public interface defines the existing state shape.'],
      }],
      ambiguities: [],
      acceptanceCriteria: [
        { id: 'AC-1', description: 'The state can be inspected', oracle: 'Inspect the state' },
        { id: 'AC-2', description: 'The runtime command succeeds', oracle: 'Run node --version' },
      ],
      verificationPlan: [
        { criterionId: 'AC-1', kind: 'inspection', instruction: 'Inspect the state', command: null },
        { criterionId: 'AC-2', kind: 'command', instruction: 'Check the runtime', command: null },
      ],
      dependencies: [],
      changeBudget: { capabilities: [], paths: [] },
    },
  };
  writeFileSync(input, JSON.stringify(result));
  const environment = { ...process.env, ...agentResultChannelEnv(channel, 'analyst-agent') };
  const rejected = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'loop', 'submit-agent-result.mjs'), '--input', input, '--consume'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /verificationPlan/);
  assert.match(rejected.stderr, /command/);
  assert.equal(readAgentResultChannel(channel), null);
  assert.equal(existsSync(input), true);

  result.spec.verificationPlan[1].command = 'node --version';
  writeFileSync(input, JSON.stringify(result));
  const accepted = execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'loop', 'submit-agent-result.mjs'), '--input', input, '--consume'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment,
  });
  assert.match(accepted, /submitted successfully/);
  assert.equal(existsSync(input), false);
  const submitted = JSON.parse(readAgentResultChannel(channel)!);
  assert.equal('command' in submitted.spec.verificationPlan[0], false);
  assert.equal(submitted.spec.verificationPlan[1].command, 'node --version');
});
