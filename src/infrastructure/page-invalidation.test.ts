import assert from 'node:assert/strict';
import test from 'node:test';
import { installPageInvalidationAdapter, invalidatePage } from './page-invalidation';

test('core invalidation works without Next and Web adapters receive the unchanged path and scope', () => {
  assert.doesNotThrow(() => invalidatePage('/without-web'));
  const calls: unknown[][] = [];
  const uninstall = installPageInvalidationAdapter((...args) => { calls.push(args); });
  try {
    invalidatePage('/tasks');
    invalidatePage('/agents', 'layout');
    assert.deepEqual(calls, [['/tasks', undefined], ['/agents', 'layout']]);
  } finally { uninstall(); }
  invalidatePage('/after-uninstall');
  assert.equal(calls.length, 2);
});

test('cache exceptions cannot turn a persisted operation into a business failure', () => {
  const uninstall = installPageInvalidationAdapter(() => { throw new Error('no request context'); });
  try { assert.doesNotThrow(() => invalidatePage('/tasks')); } finally { uninstall(); }
});
