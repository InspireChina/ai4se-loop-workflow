import assert from 'node:assert/strict';
import test from 'node:test';
import { paths } from './database';
import { buildTaskContextChatPrompt, taskContextChatPermissionArgs } from './task-context-chat-executor';

test('configures non-interactive bypass permissions for every context chat executor', () => {
  assert.deepEqual(taskContextChatPermissionArgs('cursor'), ['--force', '--trust']);
  assert.deepEqual(taskContextChatPermissionArgs('claude'), ['--dangerously-skip-permissions']);
  assert.deepEqual(taskContextChatPermissionArgs('codex'), ['--dangerously-bypass-approvals-and-sandbox']);
});

test('builds a task-bound forward-feedback contract without direct code mutation', () => {
  const prompt = buildTaskContextChatPrompt('TASK-chat-contract', 'Make the wording clearer', true);
  assert.match(prompt, /当前需求固定为 TASK-chat-contract/);
  assert.match(prompt, new RegExp(`npm --prefix ${JSON.stringify(paths.appRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} run loopctl -- task-context --task-id TASK-chat-contract`));
  assert.match(prompt, /上下文对话独立于 Loop Runner/);
  assert.match(prompt, /包含当前需求已经产出的文档/);
  assert.match(prompt, /禁止修改目标仓库文件或 Git/);
  assert.match(prompt, /禁止调用 task-update、story-add、task-context-init、task-rewind、task-cancel、system-unblock/);
  assert.match(prompt, /context-chat-change --key <稳定请求-key> --title <标题> --request <完整变更意图>/);
  assert.match(prompt, /与详情文档评论相同的 Feedback 闭环/);
  assert.match(prompt, /向前追加交付单元/);
  assert.match(prompt, /可以调用任意多次 context-chat-change，没有数量上限/);
  assert.match(prompt, /一个变更请求.*可以继续拆成多个交付单元/);
  assert.doesNotMatch(prompt, /轻量代码修改权限|创建一个 Git commit/);
  assert.match(prompt, /用户问题：\nMake the wording clearer/);
});

test('refreshes task facts on every resumed context chat turn', () => {
  const prompt = buildTaskContextChatPrompt('TASK-chat-resume', 'What changed?', false);
  assert.match(prompt, /覆盖旧轮次中“可以直接轻量修改代码”的过时说明/);
  assert.match(prompt, /必须重新运行只读命令获取最新事实/);
  assert.match(prompt, /task-context --task-id TASK-chat-resume/);
  assert.match(prompt, /如果用户只是询问、解释、比较或探索方案，直接回答/);
});
