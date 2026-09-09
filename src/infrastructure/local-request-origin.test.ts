import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedLocalRequestOrigin } from './local-request-origin';

function request(url: string, origin?: string) {
  return new Request(url, { method: 'POST', headers: origin ? { origin } : undefined });
}

test('allows an exact same-origin request and requests without an Origin header', () => {
  assert.equal(isAllowedLocalRequestOrigin(request('http://127.0.0.1:3100/api', 'http://127.0.0.1:3100')), true);
  assert.equal(isAllowedLocalRequestOrigin(request('http://127.0.0.1:3100/api')), true);
});

test('allows Windows desktop loopback aliases even when Next reconstructs another port', () => {
  assert.equal(isAllowedLocalRequestOrigin(request('http://localhost:3000/api', 'http://127.0.0.1:49152')), true);
  assert.equal(isAllowedLocalRequestOrigin(request('http://127.0.0.1:3000/api', 'http://localhost:49152')), true);
  assert.equal(isAllowedLocalRequestOrigin(request('http://[::1]:3000/api', 'http://127.0.0.1:49152')), true);
});

test('rejects external, malformed, and non-http origins', () => {
  assert.equal(isAllowedLocalRequestOrigin(request('http://127.0.0.1:3000/api', 'https://example.test')), false);
  assert.equal(isAllowedLocalRequestOrigin(request('http://127.0.0.1:3000/api', 'file://')), false);
  assert.equal(isAllowedLocalRequestOrigin(request('http://127.0.0.1:3000/api', 'not-a-url')), false);
});
