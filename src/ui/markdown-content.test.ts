import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from './markdown-content';

test('renders closure report Markdown without enabling raw HTML', () => {
  const html = renderToStaticMarkup(MarkdownContent({
    content: [
      '# 结卡报告',
      '',
      '- 已完成需求',
      '- [x] 已通过验证',
      '',
      '| 项目 | 结果 |',
      '| --- | --- |',
      '| 构建 | 通过 |',
      '',
      '```sh',
      'npm test',
      '```',
      '',
      '<script>alert("unsafe")</script>',
    ].join('\n'),
  }));

  assert.match(html, /<h1>结卡报告<\/h1>/);
  assert.match(html, /<li>已完成需求<\/li>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /<table>/);
  assert.match(html, /language-sh/);
  assert.doesNotMatch(html, /<script>/);
});
