import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const agentResultProtocol = 'loop-agent-result/v1';
export type AgentResultKind = 'flow' | 'evolution' | 'maintenance';

export type AgentResultChannel = {
  directory: string;
  resultPath: string;
  kind: AgentResultKind;
};

export function createAgentResultChannel(kind: AgentResultKind): AgentResultChannel {
  const directory = mkdtempSync(join(tmpdir(), 'lwr-'));
  return { directory, resultPath: join(directory, 'submitted-result.json'), kind };
}

export function agentResultChannelEnv(channel: AgentResultChannel) {
  return {
    LOOP_AGENT_RESULT_PATH: channel.resultPath,
    LOOP_AGENT_RESULT_PROTOCOL: agentResultProtocol,
    LOOP_AGENT_RESULT_KIND: channel.kind,
  };
}

export function readAgentResultChannel(channel: AgentResultChannel) {
  if (!existsSync(channel.resultPath)) return null;
  const raw = readFileSync(channel.resultPath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new Error('Agent 提交结果超过 2 MiB 限制');
  const envelope = JSON.parse(raw) as { protocol?: unknown; kind?: unknown; result?: unknown };
  if (envelope.protocol !== agentResultProtocol) throw new Error('Agent 结果通道协议不匹配');
  if (envelope.kind !== channel.kind) throw new Error('Agent 结果类型与当前 execution 不匹配');
  if (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw new Error('Agent 结果通道缺少 result 对象');
  return JSON.stringify(envelope.result);
}

export function removeAgentResultChannel(channel: AgentResultChannel | null) {
  if (!channel) return;
  try { rmSync(channel.directory, { recursive: true, force: true }); } catch { /* best-effort after the Agent exits */ }
}
