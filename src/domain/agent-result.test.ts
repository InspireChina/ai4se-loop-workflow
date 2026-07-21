import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAgentResultRoleContract, parseAgentResult } from './agent-result';

test('parses a structured agent result with role-specific fields', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '拆分完成',
    deliveryUnits: [{ title: '用户可以提交描述' }, { title: '用户可以查看已保存描述' }],
  }));
  assert.equal(result.outcome, 'completed');
  assert.equal(result.deliveryUnits?.length, 2);
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.runtimeInputs, []);
});

test('parses generic runtime information requests independently from product questions', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'The repository hook requires delivery metadata.',
    runtimeInputs: [{
      title: '补充交付单元卡号',
      question: '本次提交应关联哪个交付单元卡号？',
      why: '仓库 commit-msg hook 要求该字段。',
      recommendation: '没有关联卡号时请确认使用仓库约定的占位值。',
    }],
  }));
  assert.equal(result.questions.length, 0);
  assert.equal(result.runtimeInputs[0]?.title, '补充交付单元卡号');
});

test('accepts legacy story fields while exposing delivery-unit terminology', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'legacy queued result',
    stories: [{ title: 'Legacy unit' }],
    rewindStory: 1,
  }));
  assert.equal(result.deliveryUnits?.[0]?.title, 'Legacy unit');
  assert.equal(result.rewindDeliveryUnit, 1);
});

test('accepts structured JSON wrapped by common Agent formatting mistakes', () => {
  assert.equal(parseAgentResult('```json\n{"outcome":"completed","summary":"ok"}\n```').summary, 'ok');
  assert.equal(parseAgentResult('结果如下：{"outcome":"completed","summary":"ok"}').summary, 'ok');
  assert.equal(parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'artifact contains a fenced block',
    artifact: { title: 'Delegation', content: '```md\n## Delegation notes\n```' },
  })).artifact?.title, 'Delegation');
  assert.equal(parseAgentResult([
    '```md',
    '## Delegation notes',
    '这不是 JSON。',
    '```',
    '```json',
    '{"outcome":"completed","summary":"recovered"}',
    '```',
  ].join('\n')).summary, 'recovered');
  assert.throws(() => parseAgentResult('只有说明文字，没有结构化结果'));
});

test('rejects invalid workflow values', () => {
  assert.throws(() => parseAgentResult('{"outcome":"done","summary":"ok"}'));
});

test('accepts a batch of more than ten design questions', () => {
  const questions = Array.from({ length: 12 }, (_, index) => ({
    title: `Decision ${index + 1}`,
    question: `Choose option for decision ${index + 1}`,
    recommendation: 'Use the default option.',
  }));
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Analysis requires design decisions.',
    questions,
  }));
  assert.equal(result.questions.length, 12);
});

test('allows only requirement intake and analysis agents to ask product questions', () => {
  const requirementQuestion = parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'The requested boundary changes how the requirement should be split.',
    questions: [{
      decisionKey: 'supported-audience',
      title: '确认目标用户',
      question: '本次能力只面向管理员，还是同时面向普通成员？',
      why: '目标用户会改变需求范围和交付单元边界。',
      recommendation: '本轮只面向管理员。',
      alternatives: [
        { id: 'admin', label: '仅管理员', consequences: ['范围较小'] },
        { id: 'all', label: '所有成员', consequences: ['需要补充权限与兼容行为'] },
      ],
    }],
  }));

  assert.doesNotThrow(() => assertAgentResultRoleContract(requirementQuestion, 'backlog-agent'));
  assert.throws(() => assertAgentResultRoleContract(requirementQuestion, 'story-splitter-agent'), /不允许创建设计澄清问题/);
  assert.throws(
    () => assertAgentResultRoleContract({ ...requirementQuestion, outcome: 'completed' }, 'backlog-agent'),
    /outcome 必须为 needs_input/,
  );
});

test('parses a versionable Slice Spec and normalizes the legacy review verdict', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Decision tree is resolved.',
    artifact: { title: 'Resolved analysis', content: 'All product decisions are evidenced.' },
    verdict: 'ready_for_approval',
    spec: {
      goal: 'A user can close one delivery unit without ambiguity.',
      scope: { included: ['Closure behavior'], excluded: ['Unrelated redesign'] },
      behaviors: [{ scenario: 'All decisions are resolved', expected: 'Development can start' }],
      decisions: [{ key: 'closure-mode', decision: 'Acknowledge reading', rationale: 'No approval gate', source: 'user' }],
      decisionTree: [{
        key: 'closure-mode',
        question: 'How is a delivery unit closed?',
        impact: 'Changes the user-visible closure flow.',
        options: [
          { id: 'acknowledge', label: 'Acknowledge reading', consequences: ['No approval gate'] },
          { id: 'approve', label: 'Explicit approval', consequences: ['Adds an approval gate'] },
        ],
        status: 'resolved_from_context',
        selectedOption: 'acknowledge',
        source: 'user',
        evidence: ['The user explicitly requested acknowledgement without approval.'],
      }],
      ambiguities: [],
      acceptanceCriteria: [{ id: 'AC-1', description: 'The unit has a deterministic contract', oracle: 'The stored spec is resolved' }],
      verificationPlan: [{ criterionId: 'AC-1', kind: 'command', instruction: 'Run tests', command: 'npm test' }],
      dependencies: [],
      changeBudget: { capabilities: ['Task closure'], paths: ['src/application/tasks.ts'] },
    },
  }));
  assert.equal(result.verdict, 'report_ready');
  assert.equal(result.spec?.acceptanceCriteria[0]?.id, 'AC-1');
  assert.doesNotThrow(() => assertAgentResultRoleContract(result, 'analyst-agent'));
  assert.throws(
    () => assertAgentResultRoleContract({ ...result, spec: { ...result.spec!, decisionTree: [] } }, 'analyst-agent'),
    /必须包含完整 decisionTree/,
  );
});

test('requires every analysis decision to be evidenced or aligned with one user question', () => {
  const unresolved = parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'One product decision is not covered by context.',
    artifact: { title: 'Analysis', content: 'The output contract remains open.' },
    questions: [{
      decisionKey: 'output-mode',
      title: 'Choose output mode',
      question: 'Which output mode should users receive?',
      alternatives: [
        { id: 'structured', label: 'Structured', consequences: ['Stable machine contract'] },
        { id: 'text', label: 'Text', consequences: ['Optimized for reading'] },
      ],
    }],
    spec: {
      goal: 'Produce one visible output.',
      scope: { included: ['Output contract'], excluded: ['Unrelated features'] },
      behaviors: [{ scenario: 'The operation completes', expected: 'The chosen output is visible' }],
      decisions: [],
      decisionTree: [{
        key: 'output-mode',
        question: 'Which output mode should users receive?',
        impact: 'Changes the user-visible output contract.',
        options: [
          { id: 'structured', label: 'Structured', consequences: ['Stable machine contract'] },
          { id: 'text', label: 'Text', consequences: ['Optimized for reading'] },
        ],
        status: 'needs_user_input',
      }],
      ambiguities: [{ key: 'output-mode', description: 'No context chooses the visible output.' }],
      acceptanceCriteria: [{ id: 'AC-1', description: 'Output follows the chosen contract', oracle: 'Inspect output' }],
      verificationPlan: [{ criterionId: 'AC-1', kind: 'inspection', instruction: 'Inspect output' }],
      dependencies: [],
      changeBudget: { capabilities: ['Output contract'], paths: [] },
    },
  }));
  assert.doesNotThrow(() => assertAgentResultRoleContract(unresolved, 'analyst-agent'));
  assert.throws(
    () => assertAgentResultRoleContract({ ...unresolved, questions: [] }, 'analyst-agent'),
    /必须提供.*questions/,
  );

  const unsafe = parseAgentResult(JSON.stringify({
    ...unresolved,
    outcome: 'completed',
    questions: [],
    spec: {
      ...unresolved.spec,
      decisions: [{ key: 'output-mode', decision: 'Structured', rationale: 'A common default', source: 'safe_default' }],
      decisionTree: [{
        ...unresolved.spec!.decisionTree[0],
        status: 'resolved_from_context',
        selectedOption: 'structured',
        source: 'code',
        evidence: ['No explicit product evidence; selected as a default.'],
      }],
      ambiguities: [],
    },
  }));
  assert.throws(() => assertAgentResultRoleContract(unsafe, 'analyst-agent'), /不能使用 safe_default/);
});

test('parses Feedback Agent triage and verification decisions', () => {
  const triage = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Route the feedback back to implementation.',
    feedback: {
      mode: 'triage',
      commentId: 'feedback-1',
      disposition: 'rewind',
      targetStage: 'dev',
      targetAgent: 'dev-agent',
      targetDeliveryUnit: 1,
      reason: 'The comment identifies an implementation defect.',
      acceptance: ['The behavior is restored and tested.'],
    },
  }));
  assert.equal(triage.feedback?.mode, 'triage');
  const verification = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Feedback resolution verified.',
    feedback: {
      mode: 'verify',
      commentId: 'feedback-1',
      verdict: 'resolved',
      reason: 'The new behavior and evidence satisfy the feedback.',
      evidence: ['verification-run-1'],
    },
  }));
  assert.equal(verification.feedback?.mode, 'verify');
});

test('rejects Feedback Agent attempts to enter product or runtime input flows', () => {
  const result = parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'Ask the user instead of triaging feedback.',
    runtimeInputs: [{ title: 'Need a decision', question: 'What should happen?' }],
    feedback: {
      mode: 'triage',
      commentId: 'feedback-1',
      disposition: 'no_change',
      reason: 'No change proposed.',
      acceptance: [],
    },
  }));
  assert.throws(() => assertAgentResultRoleContract(result, 'feedback-agent'), /不能创建设计问题或运行信息请求/);
});
