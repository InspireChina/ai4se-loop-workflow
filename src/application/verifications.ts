import { randomUUID } from 'node:crypto';
import { sliceSpecSchema } from '../domain/agent-result';
import { databaseConnection, paths } from '../infrastructure/database';
import { executeVerificationCommand } from '../infrastructure/verification';

export type HarnessVerificationOutcome = {
  verificationId: string;
  passed: boolean;
  summary: string;
};

export async function runHarnessVerification(taskId: string, storyIndex: number, codeCommit?: string, executionId?: string): Promise<HarnessVerificationOutcome> {
  const db = await databaseConnection();
  let existing: { verification_id: string; status: string } | undefined;
  if (executionId) {
    existing = db.prepare(`
      SELECT verification_id, status
      FROM verification_runs
      WHERE execution_id = ?
    `).get(executionId) as { verification_id: string; status: string } | undefined;
    if (existing && (existing.status === 'passed' || existing.status === 'failed')) {
      const evidence = db.prepare(`
        SELECT criterion_id, command, passed
        FROM verification_evidence
        WHERE verification_id = ?
        ORDER BY created_at, evidence_id
      `).all(existing.verification_id) as { criterion_id: string; command: string | null; passed: number }[];
      return {
        verificationId: existing.verification_id,
        passed: existing.status === 'passed',
        summary: evidence.length
          ? evidence.map((item) => `${item.criterion_id}: ${item.passed ? '通过' : '失败'}${item.command ? ` (${item.command})` : ''}`).join('；')
          : '当前规格没有确定性命令步骤，由后续语义验证覆盖。',
      };
    }
  }
  const row = db.prepare(`
    SELECT revision, spec_json
    FROM story_specs
    WHERE task_id = ? AND story_index = ? AND status = 'resolved'
    ORDER BY revision DESC LIMIT 1
  `).get(taskId, storyIndex) as { revision: number; spec_json: string } | undefined;
  if (!row) throw new Error(`交付单元 ${storyIndex} 缺少 resolved Slice Spec`);
  const spec = sliceSpecSchema.parse(JSON.parse(row.spec_json));
  const commandSteps = spec.verificationPlan.filter((step) => step.kind === 'command');
  const verificationId = existing?.verification_id ?? randomUUID();
  db.transaction(() => {
    if (existing) {
      // execution_id is unique by design: interrupted attempts resume their original
      // verification run instead of creating a second row for the same execution.
      db.prepare('DELETE FROM verification_evidence WHERE verification_id = ?').run(verificationId);
      db.prepare(`
        UPDATE verification_runs
        SET task_id = ?, story_index = ?, spec_revision = ?, code_commit = ?,
            status = 'running', started_at = CURRENT_TIMESTAMP, finished_at = NULL
        WHERE verification_id = ?
      `).run(taskId, storyIndex, row.revision, codeCommit || null, verificationId);
      return;
    }
    db.prepare(`
      INSERT INTO verification_runs(verification_id, task_id, story_index, spec_revision, code_commit, status, execution_id)
      VALUES(?, ?, ?, ?, ?, 'running', ?)
    `).run(verificationId, taskId, storyIndex, row.revision, codeCommit || null, executionId || null);
  })();

  let passed = true;
  const summaries: string[] = [];
  try {
    for (const step of commandSteps) {
      if (!step.command) throw new Error(`验收标准 ${step.criterionId} 的 command 验证缺少命令`);
      let command = step.command;
      if (/\btsx --test\b/.test(command) && !/--import\b/.test(command)) {
        command = command.replace(/\btsx --test\b/, '$& --import ./src/test/setup.ts');
      }
      const result = await executeVerificationCommand(command, paths.root);
      const stepPassed = result.exitCode === 0 && !result.timedOut;
      passed &&= stepPassed;
      const outputSummary = result.output.replace(/\s+/g, ' ').trim().slice(0, 4000);
      db.prepare(`
        INSERT INTO verification_evidence(
          evidence_id, verification_id, criterion_id, kind, instruction,
          command, exit_code, output_summary, passed
        ) VALUES(?, ?, ?, 'command', ?, ?, ?, ?, ?)
      `).run(randomUUID(), verificationId, step.criterionId, step.instruction, command, result.exitCode, outputSummary, stepPassed ? 1 : 0);
      summaries.push(`${step.criterionId}: ${stepPassed ? '通过' : '失败'} (${command})`);
    }
    db.prepare(`
      UPDATE verification_runs
      SET status = ?, finished_at = CURRENT_TIMESTAMP
      WHERE verification_id = ?
    `).run(passed ? 'passed' : 'failed', verificationId);
    return {
      verificationId,
      passed,
      summary: summaries.length ? summaries.join('；') : '当前规格没有确定性命令步骤，由后续语义验证覆盖。',
    };
  } catch (error) {
    db.prepare(`UPDATE verification_runs SET status = 'error', finished_at = CURRENT_TIMESTAMP WHERE verification_id = ?`).run(verificationId);
    throw error;
  }
}
