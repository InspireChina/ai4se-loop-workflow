import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analysisDecisionMode,
  parseRequirementMetadata,
  requirementMetadataDefinition,
  requirementMetadataValueLabel,
} from './requirement-metadata';

test('parses predefined requirement metadata and ignores blank values', () => {
  assert.deepEqual(parseRequirementMetadata([{
    key: 'source.reference_url',
    value: ' https://example.test/requirements/42 ',
  }, {
    key: 'tracking.requirement_card_id',
    value: ' ',
  }]), [{
    key: 'source.reference_url',
    value: 'https://example.test/requirements/42',
  }]);
  assert.equal(requirementMetadataDefinition('tracking.requirement_card_id')?.label, '需求卡号');
  assert.equal(analysisDecisionMode([]), 'balanced');
  assert.equal(analysisDecisionMode([{
    key: 'workflow.analysis_decision_mode',
    value: 'conservative',
  }]), 'conservative');
  assert.equal(requirementMetadataValueLabel('workflow.analysis_decision_mode', 'autonomous'), '高度自主');
  assert.equal(analysisDecisionMode([{
    key: 'workflow.analysis_decision_mode',
    value: 'fully_autonomous',
  }]), 'fully_autonomous');
  assert.equal(requirementMetadataValueLabel('workflow.analysis_decision_mode', 'fully_autonomous'), '完全自主');
});

test('rejects unknown, duplicate, and unsafe URL metadata', () => {
  assert.throws(() => parseRequirementMetadata([{ key: 'unknown', value: 'value' }]), /不支持的 metadata key/);
  assert.throws(() => parseRequirementMetadata([
    { key: 'tracking.requirement_card_id', value: 'CARD-1' },
    { key: 'tracking.requirement_card_id', value: 'CARD-2' },
  ]), /不能重复添加/);
  assert.throws(() => parseRequirementMetadata([{
    key: 'source.reference_url',
    value: 'javascript:alert(1)',
  }]), /只支持 HTTP 或 HTTPS/);
  assert.throws(() => parseRequirementMetadata([{
    key: 'workflow.analysis_decision_mode',
    value: 'unbounded',
  }]), /值不受支持/);
});
