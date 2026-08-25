import assert from 'node:assert/strict';
import test from 'node:test';
import { paths } from './database';
import { buildTaskContextChatPrompt, taskContextChatPermissionArgs, taskContextChatProgressEvents } from './task-context-chat-executor';

test('configures non-interactive bypass permissions for every context chat executor', () => {
  assert.deepEqual(taskContextChatPermissionArgs('cursor'), ['--force', '--trust']);
  assert.deepEqual(taskContextChatPermissionArgs('claude'), ['--dangerously-skip-permissions']);
  assert.deepEqual(taskContextChatPermissionArgs('codex'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(taskContextChatPermissionArgs('omp'), ['--approval-mode', 'yolo']);
});

test('builds a task-bound contract with safe direct adjustments and forward feedback', () => {
  const prompt = buildTaskContextChatPrompt('TASK-chat-contract', 'Make the wording clearer', true);
  assert.match(prompt, /当前需求固定为 TASK-chat-contract/);
  assert.match(prompt, new RegExp(`npm --prefix ${JSON.stringify(paths.appRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} run loopctl -- task-context --task-id TASK-chat-contract`));
  assert.match(prompt, /上下文对话独立于 Loop Runner/);
  assert.match(prompt, /包含当前需求已经产出的文档/);
  assert.match(prompt, /轻微调整直达/);
  assert.match(prompt, /局部 UI 样式、排版、错别字或不改变含义的措辞优化/);
  assert.match(prompt, /不改变原始需求、业务意图、参与者、规则、范围、可观察结果、验收语义/);
  assert.match(prompt, /不涉及领域逻辑、数据\/Schema、API 契约、权限、安全、工作流、依赖、构建或运行配置/);
  assert.match(prompt, /Runner 状态.*loopctl -- run-status/);
  assert.match(prompt, /确认 idle/);
  assert.match(prompt, /只暂存并提交本轮自己从干净基线修改的文件/);
  assert.match(prompt, /直接完成后不要调用 context-chat-change/);
  assert.match(prompt, /禁止调用 task-update、story-add、task-context-init、task-rewind、task-cancel、system-unblock/);
  assert.match(prompt, /context-chat-change --key <稳定请求-key> --title <标题> --request <完整变更意图>/);
  assert.match(prompt, /与详情文档评论相同的 Feedback 闭环/);
  assert.match(prompt, /向前追加交付单元/);
  assert.match(prompt, /可以调用任意多次 context-chat-change，没有数量上限/);
  assert.match(prompt, /一个变更请求.*规划成一个或多个完整交付单元/);
  assert.match(prompt, /每个修改意图只能选择一种路径/);
  assert.doesNotMatch(prompt, /始终禁止修改目标仓库文件或 Git/);
  assert.match(prompt, /用户问题：\nMake the wording clearer/);
});

test('refreshes task facts on every resumed context chat turn', () => {
  const prompt = buildTaskContextChatPrompt('TASK-chat-resume', 'What changed?', false);
  assert.match(prompt, /覆盖旧轮次中“Chat 只能只读或所有修改都必须进入 Feedback”的过时说明/);
  assert.match(prompt, /必须重新运行只读命令获取最新事实/);
  assert.match(prompt, /task-context --task-id TASK-chat-resume/);
  assert.match(prompt, /如果用户只是询问、解释、比较或探索方案，直接回答/);
});

test('projects provider reasoning summaries and redacted tool lifecycle events for live Chat progress', () => {
  assert.deepEqual(taskContextChatProgressEvents('codex', JSON.stringify({
    type: 'item.completed',
    item: { type: 'reasoning', text: 'Inspecting the current delivery facts.' },
  })), [{
    kind: 'thinking',
    label: '思考进展',
    detail: 'Inspecting the current delivery facts.',
    status: 'running',
  }]);

  const started = taskContextChatProgressEvents('codex', JSON.stringify({
    type: 'item.started',
    item: { id: 'tool-1', type: 'command_execution', command: 'npm test token=private-value' },
  }));
  assert.equal(started[0]?.kind, 'tool');
  assert.equal(started[0]?.label, '终端命令');
  assert.match(started[0]?.detail || '', /token=\[REDACTED\]/);
  assert.doesNotMatch(started[0]?.detail || '', /private-value/);

  assert.deepEqual(taskContextChatProgressEvents('codex', JSON.stringify({
    type: 'item.completed',
    item: { id: 'tool-1', type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: 'passed' },
  })), [{
    kind: 'tool',
    label: '终端命令完成',
    detail: '执行完成',
    status: 'completed',
  }]);
});

test('projects Claude emitted thinking without treating final answer text as hidden reasoning', () => {
  assert.deepEqual(taskContextChatProgressEvents('claude', JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'Checking the relevant files.' }] },
  })), [{
    kind: 'thinking',
    label: '思考进展',
    detail: 'Checking the relevant files.',
    status: 'running',
  }]);
  assert.deepEqual(taskContextChatProgressEvents('claude', JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Final answer' }] },
  })), []);
});
