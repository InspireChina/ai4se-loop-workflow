import assert from 'node:assert/strict';
import test from 'node:test';
import { paths } from './database';
import { buildTaskContextChatPrompt, taskContextChatPermissionArgs } from './task-context-chat-executor';

test('configures non-interactive bypass permissions for every context chat executor', () => {
  assert.deepEqual(taskContextChatPermissionArgs('cursor'), ['--force', '--trust']);
  assert.deepEqual(taskContextChatPermissionArgs('claude'), ['--dangerously-skip-permissions']);
  assert.deepEqual(taskContextChatPermissionArgs('codex'), ['--dangerously-bypass-approvals-and-sandbox']);
});

test('builds a task-bound native CLI lightweight change contract', () => {
  const prompt = buildTaskContextChatPrompt('TASK-chat-contract', 'Make the wording clearer', true, {
    writeAllowed: true,
  });
  assert.match(prompt, /当前需求固定为 TASK-chat-contract/);
  assert.match(prompt, new RegExp(`npm --prefix ${JSON.stringify(paths.appRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} run loopctl -- task-context --task-id TASK-chat-contract`));
  assert.match(prompt, /上下文对话独立于 Loop Runner/);
  assert.match(prompt, /包含当前需求已经产出的文档/);
  assert.match(prompt, /git status --short/);
  assert.match(prompt, /禁止调用 task-update、task-context-init、task-rewind、task-cancel、system-unblock/);
  assert.match(prompt, /UI 呈现、布局、样式、可访问性和 wording/);
  assert.match(prompt, /其他需求的执行状态不影响本轮模式/);
  assert.match(prompt, /只暂存并提交自己本轮的修改/);
  assert.match(prompt, /如果无法让验证通过，必须撤销自己本轮产生的全部文件修改/);
  assert.match(prompt, /用户问题：\nMake the wording clearer/);
});

test('refreshes task facts on every resumed context chat turn', () => {
  const prompt = buildTaskContextChatPrompt('TASK-chat-resume', 'What changed?', false, {
    writeAllowed: false,
  });
  assert.match(prompt, /覆盖旧轮次中已经过时的只读说明/);
  assert.match(prompt, /必须重新运行只读命令获取最新事实/);
  assert.match(prompt, /task-context --task-id TASK-chat-resume/);
  assert.match(prompt, /本轮只允许读取和解释/);
  assert.match(prompt, /当前需求有 Dev Agent、Test Agent 或上一条 Chat 消息正在执行/);
});
