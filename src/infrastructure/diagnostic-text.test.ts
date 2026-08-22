import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeDiagnosticText } from './diagnostic-text';

test('keeps the diagnostic tail while redacting credentials', () => {
  const result = sanitizeDiagnosticText(`prefix Authorization: Bearer abcdefghijkl token=private-value\n${'x'.repeat(100)}`, 80);

  assert.equal(result.startsWith('…'), true);
  assert.doesNotMatch(result, /abcdefgh|private-value/);
  assert.match(result, /x{20}/);
});
