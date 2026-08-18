import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import {
  createRuntimeEvent,
  publishRuntimeEvent,
  RuntimeEventHub,
  runtimeEventHubDescriptorPath,
  subscribeRuntimeEvents,
} from './runtime-event-hub';

test('publishes authenticated runtime events to topic subscribers', async () => {
  const hub = new RuntimeEventHub(`test-host-${process.pid}`, 41);
  await hub.start();
  let resolveReceived!: (entityId: string) => void;
  const received = new Promise<string>((resolve) => { resolveReceived = resolve; });
  const subscription = subscribeRuntimeEvents({
    topics: ['dispatch.invalidated'],
    reconnectMs: 20,
    onEvent: (event) => resolveReceived(event.entityId || ''),
  });
  await subscription.ready;
  assert.equal(await publishRuntimeEvent(createRuntimeEvent('dispatch.invalidated', 7, { entityId: 'REQ-event' })), true);
  assert.equal(await received, 'REQ-event');
  subscription.close();
  await hub.close();
  await assert.rejects(access(runtimeEventHubDescriptorPath()));
});

test('does not publish when no lifecycle host owns the event hub', async () => {
  assert.equal(await publishRuntimeEvent(createRuntimeEvent('dispatch.invalidated', 1)), false);
});

test('runs readiness reconciliation again after reconnecting to a replacement host', async () => {
  let readyCount = 0;
  let resolveReconnected!: () => void;
  const reconnected = new Promise<void>((resolve) => { resolveReconnected = resolve; });
  const firstHub = new RuntimeEventHub(`test-host-${process.pid}`, 51);
  await firstHub.start();
  const subscription = subscribeRuntimeEvents({
    topics: ['dispatch.invalidated'],
    reconnectMs: 20,
    onEvent: () => undefined,
    onReady: () => {
      readyCount += 1;
      if (readyCount === 2) resolveReconnected();
    },
  });
  await subscription.ready;
  await firstHub.close();
  const replacementHub = new RuntimeEventHub(`replacement-host-${process.pid}`, 52);
  await replacementHub.start();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscription did not reconnect')), 2_000);
    void reconnected.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(readyCount, 2);
  subscription.close();
  await replacementHub.close();
});
