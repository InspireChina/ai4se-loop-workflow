import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadCommandChainDefinition } from './command-chain-definition';

function withDefinition(
  phases: Record<string, unknown>,
  run: () => void,
  artifacts: Record<string, unknown> = {},
) {
  const definitionArtifacts = {
    'delivery-analysis': {
      blocks: {
        impacts: {
          title: 'IMPACTS',
          cardinality: 'many',
          format: 'yaml',
          required: true,
        },
      },
    },
    ...artifacts,
  };
  const root = mkdtempSync(join(tmpdir(), 'loop-command-chain-'));
  mkdirSync(join(root, 'command-chains'));
  writeFileSync(join(root, 'command-chains', 'delivery-analysis.yaml'), [
    'version: 2',
    'id: delivery-analysis',
    'agent: analyst-agent',
    `artifacts: ${JSON.stringify(definitionArtifacts)}`,
    `phases: ${JSON.stringify(phases)}`,
  ].join('\n'));
  const previous = process.env.LOOP_APP_ROOT;
  process.env.LOOP_APP_ROOT = root;
  try { run(); }
  finally {
    if (previous === undefined) delete process.env.LOOP_APP_ROOT;
    else process.env.LOOP_APP_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('requires the built-in Delivery Unit phase', () => {
  withDefinition({
    decision_proposal: { type: 'builtin', builtin: 'decision-proposal' },
    decision_resolution: { type: 'builtin', builtin: 'decision-resolution', artifacts: ['delivery-analysis.impacts'] },
    answer_review: { type: 'builtin', builtin: 'decision-answer-review' },
    finalize: { type: 'confirmation', instructions: '最终确认' },
  }, () => {
    assert.throws(
      () => loadCommandChainDefinition('delivery-analysis'),
      /必须且只能声明一次内置 Phase delivery-unit/,
    );
  });
});

test('requires every built-in Phase to declare the common type field', () => {
  withDefinition({
    delivery_unit: { builtin: 'delivery-unit' },
    decision_proposal: { type: 'builtin', builtin: 'decision-proposal' },
    decision_resolution: { type: 'builtin', builtin: 'decision-resolution', artifacts: ['delivery-analysis.impacts'] },
    answer_review: { type: 'builtin', builtin: 'decision-answer-review' },
    finalize: { type: 'confirmation', instructions: '最终确认' },
  }, () => {
    assert.throws(
      () => loadCommandChainDefinition('delivery-analysis'),
      /phases\.delivery_unit 必须声明 type: builtin/,
    );
  });
});

test('requires the built-in Decision phases', () => {
  withDefinition({
    delivery_unit: { type: 'builtin', builtin: 'delivery-unit' },
    decision_resolution: { type: 'builtin', builtin: 'decision-resolution', artifacts: ['delivery-analysis.impacts'] },
    answer_review: { type: 'builtin', builtin: 'decision-answer-review' },
    finalize: { type: 'confirmation', instructions: '最终确认' },
  }, () => {
    assert.throws(
      () => loadCommandChainDefinition('delivery-analysis'),
      /必须且只能声明一次内置 Phase decision-proposal/,
    );
  });
});

test('rejects the removed top-level decisionTrees declaration', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-command-chain-'));
  mkdirSync(join(root, 'command-chains'));
  writeFileSync(join(root, 'command-chains', 'delivery-analysis.yaml'), [
    'version: 2',
    'id: delivery-analysis',
    'agent: analyst-agent',
    'artifacts: {}',
    'decisionTrees: {}',
    'phases: {}',
  ].join('\n'));
  const previous = process.env.LOOP_APP_ROOT;
  process.env.LOOP_APP_ROOT = root;
  try {
    assert.throws(
      () => loadCommandChainDefinition('delivery-analysis'),
      /不再支持顶层 decisionTrees/,
    );
  } finally {
    if (previous === undefined) delete process.env.LOOP_APP_ROOT;
    else process.env.LOOP_APP_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects the removed hand-written Phase shape', () => {
  withDefinition({
    delivery_unit: { type: 'builtin', builtin: 'delivery-unit' },
    legacy_phase: {
      title: 'LEGACY',
      objective: '旧格式',
      required: '旧格式',
      prohibited: '旧格式',
      commands: [],
      validators: [],
      transitions: [],
      reviewBeforeSubmit: [],
    },
    decision_proposal: { type: 'builtin', builtin: 'decision-proposal' },
    decision_resolution: { type: 'builtin', builtin: 'decision-resolution', artifacts: ['delivery-analysis.impacts'] },
    answer_review: { type: 'builtin', builtin: 'decision-answer-review' },
    finalize: { type: 'confirmation', instructions: '最终确认' },
  }, () => {
    assert.throws(
      () => loadCommandChainDefinition('delivery-analysis'),
      /必须声明 type: builtin、type: artifact 或 type: confirmation/,
    );
  });
});

test('requires decision answer review to declare its Artifact Block', () => {
  withDefinition({
    delivery_unit: { type: 'builtin', builtin: 'delivery-unit' },
    decision_proposal: { type: 'builtin', builtin: 'decision-proposal' },
    decision_resolution: { type: 'builtin', builtin: 'decision-resolution', artifacts: ['delivery-analysis.impacts'] },
    answer_review: { type: 'builtin', builtin: 'decision-answer-review' },
    finalize: { type: 'confirmation', instructions: '最终确认' },
  }, () => {
    assert.throws(
      () => loadCommandChainDefinition('delivery-analysis'),
      /phases\.answer_review 必须声明一个 Artifact Block/,
    );
  });
});

test('derives decision answer review Artifact commands and validation from YAML', () => {
  withDefinition({
    delivery_unit: { type: 'builtin', builtin: 'delivery-unit' },
    decision_proposal: { type: 'builtin', builtin: 'decision-proposal' },
    decision_resolution: { type: 'builtin', builtin: 'decision-resolution', artifacts: ['delivery-analysis.impacts'] },
    answer_review: { type: 'builtin', builtin: 'decision-answer-review', artifacts: ['analysis.review-result'] },
    finalize: { type: 'confirmation', instructions: '最终确认' },
  }, () => {
    const phase = loadCommandChainDefinition('delivery-analysis').phases.answer_review;
    assert.deepEqual(phase.artifactBlocks, [{ artifactId: 'analysis', blockId: 'review-result' }]);
    assert.ok(phase.commands.includes(
      'artifact put --artifact analysis --block review-result --content-file <text>',
    ));
    assert.ok(phase.validators.includes('artifact-required:analysis.review-result'));
  }, {
    analysis: {
      blocks: {
        'review-result': {
          title: 'REVIEW RESULT',
          cardinality: 'one',
          format: 'text',
          required: true,
        },
      },
    },
  });
});

test('derives a terminal confirmation without validators', () => {
  withDefinition({
    delivery_unit: { type: 'builtin', builtin: 'delivery-unit' },
    decision_proposal: { type: 'builtin', builtin: 'decision-proposal' },
    decision_resolution: { type: 'builtin', builtin: 'decision-resolution', artifacts: ['delivery-analysis.impacts'] },
    answer_review: { type: 'builtin', builtin: 'decision-answer-review', artifacts: ['analysis.review-result'] },
    finalize: { type: 'confirmation', instructions: '复查全部结果后确认提交。' },
  }, () => {
    const phase = loadCommandChainDefinition('delivery-analysis').phases.finalize;
    assert.equal(phase.type, 'confirmation');
    assert.equal(phase.builtin, null);
    assert.deepEqual(phase.artifactBlocks, []);
    assert.deepEqual(phase.validators, []);
    assert.deepEqual(phase.commands, [
      'phase complete',
      'phase rewind --to <earlier-phase> --reason <原因>',
    ]);
  }, {
    analysis: {
      blocks: {
        'review-result': {
          title: 'REVIEW RESULT',
          cardinality: 'one',
          format: 'text',
          required: true,
        },
      },
    },
  });
});

test('derives an intermediate confirmation as an unchecked phase transition', () => {
  withDefinition({
    delivery_unit: { type: 'builtin', builtin: 'delivery-unit' },
    checkpoint: { type: 'confirmation', instructions: '检查后确认继续。' },
    decision_proposal: { type: 'builtin', builtin: 'decision-proposal' },
    decision_resolution: { type: 'builtin', builtin: 'decision-resolution', artifacts: ['delivery-analysis.impacts'] },
    answer_review: { type: 'builtin', builtin: 'decision-answer-review', artifacts: ['analysis.review-result'] },
    finalize: { type: 'confirmation', instructions: '最终确认。' },
  }, () => {
    const phase = loadCommandChainDefinition('delivery-analysis').phases.checkpoint;
    assert.deepEqual(phase.validators, []);
    assert.deepEqual(phase.commands, [
      'phase complete',
      'phase rewind --to <earlier-phase> --reason <原因>',
    ]);
    assert.deepEqual(phase.transitions, ['delivery_unit', 'decision_proposal']);
  }, {
    analysis: {
      blocks: {
        'review-result': {
          title: 'REVIEW RESULT',
          cardinality: 'one',
          format: 'text',
          required: true,
        },
      },
    },
  });
});
