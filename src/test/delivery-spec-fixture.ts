import type { DeliverySpec } from '../domain/agent-result';

export function deliverySpecFixture(overrides: Partial<DeliverySpec> = {}): DeliverySpec {
  const sourceKey = 'acceptance:fixture';
  return {
    unit: {
      key: 'fixture-unit',
      title: 'Fixture delivery unit',
      actor: 'User',
      trigger: 'The fixture action is invoked',
      observableOutcome: 'The fixture result is visible',
      acceptance: 'The fixture result can be independently verified',
      sourceRefs: [{
        key: sourceKey,
        kind: 'acceptance',
        content: 'The fixture result is independently verifiable',
        sourceRef: 'TEST:acceptance:fixture',
      }],
      dependsOn: [],
    },
    acceptances: [{
      id: 'ACCEPTANCE-fixture',
      key: 'unit:fixture-unit',
      scope: 'delivery_unit',
      statement: 'The fixture result can be independently verified',
      oracle: 'The fixture result is visible from the real user entry point',
      sourceRef: 'TEST:acceptance:fixture',
      revision: 1,
    }],
    summary: 'The fixture affects one deterministic capability and introduces no unresolved decisions.',
    impacts: [{
      key: 'fixture-impact',
      area: 'Fixture capability',
      finding: 'The fixture behavior must expose a visible result',
      disposition: 'change',
      evidence: 'The test controls all fixture inputs',
    }],
    decisions: [],
    handoff: {
      implementationGuidance: 'Implement or inspect the smallest change that exposes the fixture result.',
      guardrails: [],
      verificationFocus: [{
        key: 'AC-1',
        expected: 'The fixture behavior succeeds',
        oracle: 'The fixture assertion passes',
      }],
    },
    ...overrides,
  };
}
