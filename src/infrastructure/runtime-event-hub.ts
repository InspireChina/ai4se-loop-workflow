import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from './database';

export const RUNTIME_EVENT_TOPICS = [
  'dispatch.invalidated',
  'task.progressed',
  'schedule.invalidated',
  'execution.cancel-requested',
  'lifecycle.runner-stop-requested',
] as const;

export type RuntimeEventTopic = typeof RUNTIME_EVENT_TOPICS[number];

export type RuntimeEvent = {
  eventId: string;
  topic: RuntimeEventTopic;
  revision: number;
  occurredAt: string;
  entityId?: string;
  payload?: Record<string, unknown>;
};

type RuntimeEventHubDescriptor = {
  protocol: 1;
  endpoint: string;
  secret: string;
  ownerId: string;
  fencingToken: number;
  pid: number;
  createdAt: string;
};

type Subscriber = { socket: Socket; topics: Set<RuntimeEventTopic> };

const MAX_MESSAGE_BYTES = 64 * 1024;

export function runtimeEventHubDescriptorPath() {
  return join(paths.dataDir, 'runtime-event-hub.json');
}

function runtimeEventEndpoint(fencingToken: number, secret: string) {
  const name = `loopwork-${paths.repoHash}-${fencingToken}-${secret.slice(0, 8)}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`);
}

function isRuntimeEventTopic(value: unknown): value is RuntimeEventTopic {
  return typeof value === 'string' && (RUNTIME_EVENT_TOPICS as readonly string[]).includes(value);
}

function parseRuntimeEvent(value: unknown): RuntimeEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.eventId !== 'string' || !isRuntimeEventTopic(item.topic)
    || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0
    || typeof item.occurredAt !== 'string') return null;
  if (item.entityId !== undefined && typeof item.entityId !== 'string') return null;
  if (item.payload !== undefined && (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload))) return null;
  return item as RuntimeEvent;
}

function jsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

async function readDescriptor(): Promise<RuntimeEventHubDescriptor | null> {
  try {
    const parsed = JSON.parse(await readFile(runtimeEventHubDescriptorPath(), 'utf8')) as RuntimeEventHubDescriptor;
    if (parsed.protocol !== 1 || !parsed.endpoint || !parsed.secret || !Number.isSafeInteger(parsed.fencingToken)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class RuntimeEventHub {
  private server: Server | undefined;
  private descriptor: RuntimeEventHubDescriptor | undefined;
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly ownerId: string, private readonly fencingToken: number) {}

  get token() {
    return this.fencingToken;
  }

  private broadcast(event: RuntimeEvent) {
    const message = jsonLine({ kind: 'event', event });
    for (const subscriber of this.subscribers) {
      if (!subscriber.topics.has(event.topic)) continue;
      if (subscriber.socket.destroyed || subscriber.socket.writableLength > MAX_MESSAGE_BYTES) {
        subscriber.socket.destroy();
        this.subscribers.delete(subscriber);
        continue;
      }
      subscriber.socket.write(message);
    }
  }

  private accept(socket: Socket) {
    socket.setNoDelay(true);
    let buffer = '';
    let authenticated = false;
    let subscriber: Subscriber | undefined;
    const cleanup = () => {
      if (subscriber) this.subscribers.delete(subscriber);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          socket.end(jsonLine({ kind: 'error', error: 'invalid-json' }));
          return;
        }
        if (!authenticated) {
          if (message.secret !== this.descriptor?.secret || message.fencingToken !== this.fencingToken) {
            socket.end(jsonLine({ kind: 'error', error: 'unauthorized' }));
            return;
          }
          authenticated = true;
          if (message.kind === 'subscribe') {
            const requested = Array.isArray(message.topics) ? message.topics.filter(isRuntimeEventTopic) : [];
            subscriber = { socket, topics: new Set(requested) };
            this.subscribers.add(subscriber);
            socket.write(jsonLine({ kind: 'ready', fencingToken: this.fencingToken }));
            continue;
          }
          if (message.kind !== 'publish') {
            socket.end(jsonLine({ kind: 'error', error: 'unsupported-kind' }));
            return;
          }
        }
        if (message.kind === 'publish') {
          const event = parseRuntimeEvent(message.event);
          if (!event) {
            socket.end(jsonLine({ kind: 'error', error: 'invalid-event' }));
            return;
          }
          this.broadcast(event);
          socket.end(jsonLine({ kind: 'ack', eventId: event.eventId }));
        }
      }
    });
  }

  async start() {
    if (this.server) return;
    await mkdir(paths.dataDir, { recursive: true });
    const secret = randomUUID().replaceAll('-', '');
    const endpoint = runtimeEventEndpoint(this.fencingToken, secret);
    if (process.platform !== 'win32') await unlink(endpoint).catch(() => undefined);
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.unref();
    if (process.platform !== 'win32') await chmod(endpoint, 0o600).catch(() => undefined);
    const descriptor: RuntimeEventHubDescriptor = {
      protocol: 1,
      endpoint,
      secret,
      ownerId: this.ownerId,
      fencingToken: this.fencingToken,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    const descriptorPath = runtimeEventHubDescriptorPath();
    const temporaryPath = `${descriptorPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(descriptor), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, descriptorPath);
    this.server = server;
    this.descriptor = descriptor;
  }

  async close() {
    const server = this.server;
    const descriptor = this.descriptor;
    this.server = undefined;
    this.descriptor = undefined;
    for (const subscriber of this.subscribers) subscriber.socket.destroy();
    this.subscribers.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (descriptor) {
      const current = await readDescriptor();
      if (current?.secret === descriptor.secret) await unlink(runtimeEventHubDescriptorPath()).catch(() => undefined);
      if (process.platform !== 'win32') await unlink(descriptor.endpoint).catch(() => undefined);
    }
  }
}

export function createRuntimeEvent(topic: RuntimeEventTopic, revision: number, options: { entityId?: string; payload?: Record<string, unknown> } = {}): RuntimeEvent {
  return {
    eventId: randomUUID(),
    topic,
    revision,
    occurredAt: new Date().toISOString(),
    ...options,
  };
}

export async function publishRuntimeEvent(event: RuntimeEvent, timeoutMs = 1_000) {
  const descriptor = await readDescriptor();
  if (!descriptor) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let buffer = '';
    const socket = createConnection(descriptor.endpoint);
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once('connect', () => socket.write(jsonLine({
      kind: 'publish',
      secret: descriptor.secret,
      fencingToken: descriptor.fencingToken,
      event,
    })));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\n')) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as { kind?: string; eventId?: string };
        finish(response.kind === 'ack' && response.eventId === event.eventId);
      } catch {
        finish(false);
      }
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

export type RuntimeEventSubscription = {
  ready: Promise<void>;
  close(): void;
};

export function subscribeRuntimeEvents(input: {
  topics: readonly RuntimeEventTopic[];
  onEvent: (event: RuntimeEvent) => void;
  onReady?: () => void | Promise<void>;
  reconnectMs?: number;
}): RuntimeEventSubscription {
  let closed = false;
  let socket: Socket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let readyResolved = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  const reconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, Math.max(100, input.reconnectMs ?? 1_000));
    reconnectTimer.unref();
  };

  const connect = async () => {
    if (closed) return;
    const descriptor = await readDescriptor();
    if (!descriptor) {
      reconnect();
      return;
    }
    let buffer = '';
    const current = createConnection(descriptor.endpoint);
    socket = current;
    current.setNoDelay(true);
    current.once('connect', () => current.write(jsonLine({
      kind: 'subscribe',
      secret: descriptor.secret,
      fencingToken: descriptor.fencingToken,
      topics: input.topics,
    })));
    current.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) {
        current.destroy();
        return;
      }
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as { kind?: string; event?: unknown };
          if (message.kind === 'ready') {
            const readyWork = Promise.resolve().then(() => input.onReady?.()).catch(() => undefined);
            if (!readyResolved) {
              readyResolved = true;
              void readyWork.then(resolveReady);
            }
          } else if (message.kind === 'event') {
            const event = parseRuntimeEvent(message.event);
            if (event) input.onEvent(event);
          }
        } catch {
          current.destroy();
        }
      }
    });
    const disconnected = () => {
      if (socket === current) socket = undefined;
      reconnect();
    };
    current.once('error', disconnected);
    current.once('close', disconnected);
  };

  void connect();
  return {
    ready,
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      socket?.destroy();
      socket = undefined;
    },
  };
}
