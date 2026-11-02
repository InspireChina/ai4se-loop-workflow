import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRunLogLine } from './run-log';

test('renders OMP domain commands separately from ordinary shell calls', () => {
  const parsed=parseRunLogLine('2026-11-02T00:00:00Z [执行器工具] executor=omp agent=backlog-agent requirement=REQ-1 flow=resume tool=agent-command - 调用：恢复需求上下文草稿');
  assert.equal(parsed?.title,'调用 Agent 领域命令');
  assert.equal(parsed?.detail,'恢复需求上下文草稿');
});
test('keeps native OMP warnings and errors visible', () => {
  const warning=parseRunLogLine('2026-11-02T00:00:00Z [执行器警告] executor=omp agent=dev-agent - WARN: provider retry');
  assert.match(warning?.detail||'',/provider retry/);
  const error=parseRunLogLine('2026-11-02T00:00:00Z [执行器错误] executor=omp agent=dev-agent - provider unavailable');
  assert.equal(error?.status,'error');assert.match(error?.detail||'',/provider unavailable/);
});
