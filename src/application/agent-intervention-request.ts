import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { agentResultSchema, assertAgentResultRoleContract, type AgentResult } from '../domain/agent-result';

export const interventionRequestHelp = [
  '## INTERVENTION · 任意阶段均可使用',
  '- `intervention request --summary-file <问题摘要> --reason-file <阻塞原因> --evidence-file <调查证据>`',
  '正常完成仍使用当前角色终止命令；发现自身无法可靠化解的矛盾或阻塞时可请求系统辅助仲裁。',
  '先执行 status（Direct 使用 direct run），文件放在 $LOOP_AGENT_TMP_DIR。',
  '请求成功后立即结束执行；保存当前草稿和现场，等待 Harness 介入，不声明完成、不消耗错误重试额度。',
  '如果输入已明确回答后仍无法执行，或已确认所需条件与当前任务范围/冻结契约矛盾，不要反复索取同一材料、改写 Oracle 或伪造通过；保留已调查证据，使用 intervention request 交出当前执行。',
].join('\n');

/** A terminal submission receipt, not another source of workflow state. */
export function submitAgentInterventionRequestInDb(db: Database.Database, input: {
  executionId: string;
  agent: string;
  flags: Map<string, string>;
  draftId: string | null;
  phase: string;
}) {
  for (const name of input.flags.keys()) {
    if (!['summary', 'reason', 'evidence'].includes(name)) throw new Error(`请求介入不接受 --${name}；目标由当前 execution 决定`);
  }
  const result = agentResultSchema.parse({
    outcome: 'needs_input', summary: input.flags.get('summary'),
    intervention: { reason: input.flags.get('reason'), evidence: input.flags.get('evidence') },
  });
  assertAgentResultRoleContract(result, input.agent);
  return db.transaction(() => {
    const existing = db.prepare(`SELECT payload_json FROM execution_receipts
      WHERE execution_id = ? AND kind = 'intervention_submission' AND receipt_key = 'request'`)
      .get(input.executionId) as { payload_json: string } | undefined;
    if (existing) {
      const previous = JSON.parse(existing.payload_json) as { result: AgentResult };
      if (JSON.stringify(previous.result) !== JSON.stringify(result)) throw new Error('本次介入请求已提交，不能改写历史请求');
      return '# COMMAND RESULT\n\n- Command: intervention request\n- Outcome: already_submitted\n- Agent Action: end_execution';
    }
    const updated = db.prepare(`UPDATE execution_attempts SET status = 'output_received', result_json = ?,
      heartbeat_at = CURRENT_TIMESTAMP WHERE execution_id = ? AND status = 'running'`)
      .run(JSON.stringify(result), input.executionId);
    if (updated.changes !== 1) throw new Error('当前 execution 已结束或已提交其他结果，不能请求介入');
    db.prepare(`INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
      VALUES(?, ?, 'intervention_submission', 'request', ?)`)
      .run(randomUUID(), input.executionId, JSON.stringify({ result, draftId: input.draftId, phase: input.phase }));
    return '# COMMAND RESULT\n\n- Command: intervention request\n- Outcome: submitted\n- Owner: Harness\n- Agent Action: end_execution';
  }).immediate();
}
