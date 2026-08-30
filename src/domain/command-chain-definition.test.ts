import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { COMMAND_CHAIN_CATALOG } from './command-chain-catalog';
import { parseCommandChainDefinition } from './command-chain-definition';

let currentDefinitionYaml = '';

function loadTestDefinition() {
  return parseCommandChainDefinition('delivery-analysis', currentDefinitionYaml);
}

function withDefinition(
  phases: Record<string, unknown>,
  run: () => void,
  artifacts: Record<string, unknown> = {},
) {
  const rawArtifacts = {
    'delivery-analysis': {
      blocks: {
        impacts: {
          title: 'IMPACTS',
          cardinality: 'many',
          format: 'yaml',
          required: true,
          render: false,
          fields: {
            finding: { type: 'string', required: true, label: '发现' },
          },
        },
      },
    },
    ...artifacts,
  };
  const definitionArtifacts = Object.fromEntries(Object.entries(rawArtifacts).map(([artifactId, artifact]) => [
    artifactId,
    { title: artifactId, ...(artifact as Record<string, unknown>) },
  ]));
  currentDefinitionYaml = [
    'version: 2',
    'id: delivery-analysis',
    'agent: analyst-agent',
    `artifacts: ${JSON.stringify(definitionArtifacts)}`,
    `phases: ${JSON.stringify(phases)}`,
  ].join('\n');
  run();
}

test('requires the built-in Delivery Unit phase', () => {
  withDefinition({
    decision_proposal: { type: 'builtin', builtin: 'decision-proposal' },
    decision_resolution: { type: 'builtin', builtin: 'decision-resolution', artifacts: ['delivery-analysis.impacts'] },
    answer_review: { type: 'builtin', builtin: 'decision-answer-review' },
    finalize: { type: 'confirmation', instructions: '最终确认' },
  }, () => {
    assert.throws(
      () => loadTestDefinition(),
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
      () => loadTestDefinition(),
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
      () => loadTestDefinition(),
      /必须且只能声明一次内置 Phase decision-proposal/,
    );
  });
});

test('rejects the removed top-level decisionTrees declaration', () => {
  const yaml = [
    'version: 2',
    'id: delivery-analysis',
    'agent: analyst-agent',
    'artifacts: {}',
    'decisionTrees: {}',
    'phases: {}',
  ].join('\n');
  assert.throws(
    () => parseCommandChainDefinition('delivery-analysis', yaml),
    /不再支持顶层 decisionTrees/,
  );
});

test('requires YAML to bind the Agent declared by the command-chain catalog', () => {
  withDefinition({}, () => {
    const yaml = currentDefinitionYaml.replace('agent: analyst-agent', 'agent: dev-agent');
    assert.throws(
      () => parseCommandChainDefinition('delivery-analysis', yaml),
      /必须绑定 Agent analyst-agent/,
    );
  });
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
      () => loadTestDefinition(),
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
      () => loadTestDefinition(),
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
    const phase = loadTestDefinition().phases.answer_review;
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
    const definition = loadTestDefinition();
    const phase = definition.phases.finalize;
    assert.equal(phase.type, 'confirmation');
    assert.equal(phase.builtin, null);
    assert.deepEqual(phase.artifactBlocks, []);
    assert.deepEqual(phase.validators, []);
    assert.deepEqual(phase.commands, [
      'phase complete',
      'phase rewind --to <earlier-phase> --reason <原因>',
    ]);
    assert.equal(definition.artifacts['delivery-analysis'].title, 'delivery-analysis');
    assert.equal(definition.artifacts['delivery-analysis'].blocks.impacts.render, false);
    assert.equal(definition.artifacts['delivery-analysis'].blocks.impacts.fields.finding.label, '发现');
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
    const phase = loadTestDefinition().phases.checkpoint;
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

test('gives every bundled Artifact YAML field a human-readable label', () => {
  const appRoot = process.env.LOOP_APP_ROOT || process.cwd();
  for (const item of COMMAND_CHAIN_CATALOG) {
    const yaml = readFileSync(join(appRoot, 'command-chains', item.fileName), 'utf8');
    const definition = parseCommandChainDefinition(item.id, yaml);
    for (const [artifactId, artifact] of Object.entries(definition.artifacts)) {
      for (const [blockId, block] of Object.entries(artifact.blocks)) {
        for (const [fieldName, field] of Object.entries(block.fields)) {
          assert.ok(
            field.label?.trim(),
            `${item.fileName}: artifacts.${artifactId}.blocks.${blockId}.fields.${fieldName} 缺少 label`,
          );
        }
      }
    }
  }
});
