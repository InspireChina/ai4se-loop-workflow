import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AcceptanceContracts } from '../../app/tasks/[taskId]/acceptance-contracts';

test('renders Acceptance as a readable cross-Agent contract instead of a raw document row', () => {
  const html = renderToStaticMarkup(createElement(AcceptanceContracts, {
    acceptances: [{
      acceptance_id: 'ACCEPTANCE-download-filter',
      task_id: 'TASK-acceptance-render',
      acceptance_key: 'download-matches-filter',
      scope_type: 'requirement' as const,
      story_index: null,
      statement: '用户下载的结果只包含当前筛选范围。',
      oracle: '从真实下载入口取得的记录均满足页面当前筛选条件。',
      source_ref: 'REQUIREMENT:TASK-acceptance-render:download-filter',
      revision: 2,
      lifecycle: 'active' as const,
      assigned_story_indexes: [1, 2],
      assessments: [{
        kind: 'implementation' as const,
        agent: 'dev-agent',
        execution_id: 'EXEC-dev',
        result: 'claimed' as const,
        evidence: '下载查询复用已冻结的筛选条件。',
        created_at: '2026-08-29T08:00:00.000Z',
      }, {
        kind: 'verification' as const,
        agent: 'test-agent',
        execution_id: 'EXEC-test',
        result: 'passed' as const,
        evidence: '真实入口下载结果与页面筛选一致。',
        created_at: '2026-08-29T09:00:00.000Z',
      }],
    }],
  }));

  assert.match(html, /需求级契约/);
  assert.match(html, /用户下载的结果只包含当前筛选范围/);
  assert.match(html, /判定标准/);
  assert.match(html, /承接单元/);
  assert.match(html, /交付单元 1/);
  assert.match(html, /实现声明/);
  assert.match(html, /独立验证/);
  assert.match(html, /验证通过/);
  assert.match(html, /download-matches-filter/);
});
