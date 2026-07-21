import assert from 'node:assert/strict';
import test from 'node:test';
import { paths } from './database';
import { buildTaskContextChatPrompt, taskContextChatPermissionArgs } from './task-context-chat-executor';

test('configures non-interactive bypass permissions for every context chat executor', () => {
  assert.deepEqual(taskContextChatPermissionArgs('cursor'), ['--force', '--trust']);
  assert.deepEqual(taskContextChatPermissionArgs('claude'), ['--dangerously-skip-permissions']);
  assert.deepEqual(taskContextChatPermissionArgs('codex'), ['--dangerously-bypass-approvals-and-sandbox']);
});

test('builds a task-bound native CLI read-only context chat contract', () => {
  const prompt = buildTaskContextChatPrompt('TASK-chat-contract', 'Where is the evidence?', true);
  assert.match(prompt, /当前需求固定为 TASK-chat-contract/);
  assert.match(prompt, new RegExp(`npm --prefix ${JSON.stringify(paths.appRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} run loopctl -- task-context TASK-chat-contract`));
  assert.match(prompt, /rg、sed/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /禁止调用 task-update、task-context-init、task-rewind、task-cancel、system-unblock/);
  assert.match(prompt, /不能修改代码、文件、Git、数据库、需求状态/);
  assert.match(prompt, /用户问题：\nWhere is the evidence\?/);
});

test('refreshes task facts on every resumed context chat turn', () => {
  const prompt = buildTaskContextChatPrompt('TASK-chat-resume', 'What changed?', false);
  assert.match(prompt, /继续遵守本会话首轮的只读职责/);
  assert.match(prompt, /必须重新运行只读命令获取最新事实/);
  assert.match(prompt, /task-context TASK-chat-resume/);
});
