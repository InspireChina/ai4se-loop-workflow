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

test('turns Cursor reconnect events into Agent-scoped diagnostics', () => {
  const parsed = parseRunLogLine(
    '2026-09-09T05:20:29.639Z [执行器事件] executor=cursor lane=control agent=idea-context-agent '
    + 'requirement=REQ-1 unit=- flow=ba-intent - '
    + '{"type":"connection","subtype":"reconnecting","session_id":"session-1","attempt":1}',
  );

  assert.equal(parsed?.kind, 'executor');
  assert.equal(parsed?.status, 'running');
  assert.equal(parsed?.title, 'Cursor 连接重试');
  assert.equal(parsed?.detail, '正在重新连接（第 1 次）');
  assert.equal(parsed?.meta.cursorConnectionSession, 'session-1');
});

test('hides Cursor retry protocol noise', () => {
  const parsed = parseRunLogLine(
    '2026-09-09T05:20:31.668Z [执行器事件] executor=cursor agent=idea-context-agent '
    + 'requirement=REQ-1 flow=ba-intent - '
    + '{"type":"retry","subtype":"starting","session_id":"session-1","attempt":1,"is_resume":true}',
  );

  assert.equal(parsed, null);
});
