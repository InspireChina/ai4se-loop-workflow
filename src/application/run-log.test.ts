import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRunLogLine } from './run-log';

test('hides harmless Codex plugin manifest warnings', () => {
  const line = '2026-07-25T03:58:12Z [执行器警告] executor=codex agent=backlog-agent - '
    + 'WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: maximum of 3 prompts is supported path=file:///plugin.json';
  assert.equal(parseRunLogLine(line), null);
});

test('renders Agent domain commands separately from ordinary shell calls', () => {
  const parsed = parseRunLogLine(
    '2026-07-25T03:58:12Z [执行器工具] executor=codex agent=backlog-agent '
    + 'requirement=REQ-1 flow=resume tool=agent-command - 调用：恢复需求上下文草稿',
  );
  assert.equal(parsed?.title, '调用 Agent 领域命令');
  assert.equal(parsed?.detail, '恢复需求上下文草稿');
});
