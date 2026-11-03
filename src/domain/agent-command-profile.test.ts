import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentCommandChains,
  agentCommandProfile,
  agentCommandPrompt,
  agentCommandProfiles,
  agentContextHelpLines,
  agentCommandWorkKey,
} from './agent-command-profile';
import { loadCommandChainDefinition } from './command-chain-definition';
import { COMMAND_CHAIN_CATALOG } from './command-chain-catalog';

test('planning drafts use stable requirement or feedback-group identity across physical dispatch attempts', () => {
  const first='dispatch:generation:execution-a';
  const retry='dispatch:generation:execution-b';
  assert.equal(agentCommandWorkKey('story-splitter-agent','split','REQ-work',null,first),'delivery-plan:REQ-work:split:task');
  assert.equal(agentCommandWorkKey('story-splitter-agent','split','REQ-work',null,retry),'delivery-plan:REQ-work:split:task');
  const feedback=(dispatch:string,group:string)=>agentCommandWorkKey('story-splitter-agent','feedback-split','REQ-work',null,dispatch,group);
  assert.equal(feedback(first,'group-a'),feedback(retry,'group-a'));
  assert.notEqual(feedback(first,'group-a'),feedback(first,'group-b'));
  assert.throws(()=>agentCommandWorkKey('story-splitter-agent','feedback-split','REQ-work',null,first),/稳定工作组/);
});

test('projects workspace command scripts as real phases with their available commands', () => {
  const [chain] = agentCommandChains('backlog-agent');
  assert.equal(chain.pipeline, 'backlog');
  assert.equal(chain.entryCommand, 'status');
  assert.equal(chain.phases.length, 9);
  assert.deepEqual(chain.phases.map((phase) => phase.id), [
    'as_is',
    'decision_proposal',
    'decision_resolution',
    'answer_review',
    'to_be',
    'impact_scan',
    'scope',
    'acceptance',
    'finalize',
  ]);
  assert.equal(chain.phases[0].title, 'AS IS');
  assert.equal(chain.phases[0].type, 'artifact');
  assert.ok(chain.phases[0].commands.some((command) => command.startsWith('artifact put --artifact requirement-context')));
  assert.ok(chain.phases[1].commands.some((command) => command.startsWith('decision put --tree decisions')));
  assert.deepEqual(chain.phases.at(-1)?.commands, ['phase complete']);
  assert.deepEqual(chain.terminalActions, ['phase complete']);
});

test('keeps fixed Pipeline identities while all definitions come from workspace Agent scripts', () => {
  const profile = agentCommandProfile('backlog-agent', 'backlog');
  assert.equal(profile?.commandChainId, 'requirement-context');
  for (const item of COMMAND_CHAIN_CATALOG) {
    const definition = loadCommandChainDefinition(item.id);
    assert.equal(definition.agent, item.agentId);
    assert.deepEqual(Object.keys(loadCommandChainDefinition(item.id).phases), Object.keys(definition.phases));
  }
});

test('injects the complete read-only context and submission contract before Agent work', () => {
  const prompt = agentCommandPrompt('/opt/Loop Work', 'analyst-agent', 'analysis');
  assert.ok(prompt);
  assert.match(prompt, /# Agent Tool Contract/);
  assert.match(prompt, /loop-agent\.mjs" status/);
  assert.match(prompt, /agent-context overview/);
  assert.match(prompt, /agent-context list/);
  assert.match(prompt, /agent-context get/);
  assert.match(prompt, /agent-context search/);
  assert.match(prompt, /agent-context evidence/);
  assert.match(prompt, /agent-context history/);
  assert.match(prompt, /通用命令链/);
  assert.match(prompt, /Artifact、Decision 和 Phase/);
  assert.match(prompt, /loop-agent\.mjs" help/);
  assert.match(prompt, /phase complete/);
  assert.match(prompt, /\*\*首次必须执行：\*\*\n```bash/);
  assert.match(prompt, /- `npm --prefix/);
  assert.match(prompt, /\$LOOP_AGENT_TMP_DIR/);
  assert.doesNotMatch(prompt, /## 工具选择顺序|## 命令行为/);
  assert.doesNotMatch(prompt, /implementation complete/);
});

test('every configured role chain renders all terminal actions and forbids intermediate exit', () => {
  for (const profile of agentCommandProfiles()) {
    assert.ok(profile.terminalActions.length > 0, `${profile.id} has no terminal action`);
    for (const pipeline of profile.pipelines) {
      const prompt = agentCommandPrompt('/app', profile.agent, pipeline);
      assert.ok(prompt, `${profile.agent}/${pipeline} has no command prompt`);
      for (const action of profile.terminalActions) {
        assert.match(prompt, new RegExp(action.split(' --')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      assert.match(prompt, /CLI exit 0/);
      assert.match(prompt, /只有.*(?:submit|phase complete|终止命令).*才能结束 execution|不能在角色终止命令成功前主动结束 execution/);
    }
  }
});

test('shares one context command guide with prompt and help surfaces', () => {
  const lines = agentContextHelpLines('C:\\Loop Work');
  const content = lines.join('\n');
  assert.match(content, /agent-context overview/);
  assert.match(content, /不知道准确 ref 时使用/);
  assert.match(content, /Prompt 给出 Required Context Refs 时优先使用/);
  assert.match(content, /- `npm --prefix/);
  assert.match(content, /仅在资料存在版本、替代或冲突疑问时检查历史/);
});

test('advertises a role-specific command guide for every progressive flow Agent', () => {
  const direct = agentCommandPrompt('/app', 'direct-agent', 'direct');
  const backlog = agentCommandPrompt('/app', 'backlog-agent', 'backlog');
  const splitter = agentCommandPrompt('/app', 'story-splitter-agent', 'split');
  const analyst = agentCommandPrompt('/app', 'analyst-agent', 'analysis');
  const development = agentCommandPrompt('/app', 'dev-agent', 'dev');
  const verification = agentCommandPrompt('/app', 'test-agent', 'test');
  const review = agentCommandPrompt('/app', 'review-agent', 'review');
  const ideaContext = agentCommandPrompt('/app', 'idea-context-agent', 'ba-intent');
  const businessDesign = agentCommandPrompt('/app', 'business-design-agent', 'ba-design');
  const requirementSpec = agentCommandPrompt('/app', 'requirement-spec-agent', 'ba-spec');
  const specReview = agentCommandPrompt('/app', 'spec-review-agent', 'ba-review');
  assert.match(direct || '', /direct run/);
  assert.match(direct || '', /direct submit/);
  assert.doesNotMatch(direct || '', /direct status|needs_input|request-input/);
  const progressivePrompts = [
    ideaContext,
    businessDesign,
    requirementSpec,
    specReview,
    backlog,
    splitter,
    analyst,
    development,
    verification,
    review,
  ];
  for (const prompt of progressivePrompts) {
    assert.match(prompt || '', /通用命令链/);
    assert.match(prompt || '', /loop-agent\.mjs" status/);
    assert.match(prompt || '', /loop-agent\.mjs" help/);
    assert.match(prompt || '', /phase complete/);
    assert.match(prompt || '', /phase rewind --to <earlier-phase>/);
  }
  for (const prompt of [ideaContext, businessDesign, requirementSpec, specReview]) {
    assert.doesNotMatch(prompt || '', /idea-context |business-design |requirement-spec |spec-review /);
    assert.doesNotMatch(prompt || '', /request-clarification|return-gap|return-revision|approve/);
  }
  assert.doesNotMatch(review || '', /review request-input/);
  assert.doesNotMatch(verification || '', /verification (?:complete|request-input|pass|fail|block)/);
  assert.doesNotMatch(development || '', /help <[^>]*handoff/);
  assert.doesNotMatch(development || '', /implementation fail --reason <原因与证据>/);
  assert.doesNotMatch(analyst || '', /--reason <原因与证据>/);
  assert.doesNotMatch(direct || '', /loop-agent\.mjs" help\n/);
});
