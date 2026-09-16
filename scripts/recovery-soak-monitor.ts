import Database from 'better-sqlite3';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { auditRecoveryAcceptance } from '../src/infrastructure/recovery-acceptance-audit';
import { runRecoverySoak } from '../src/infrastructure/recovery-soak';

function parse(args: string[]) {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || Object.hasOwn(values, key)) throw new Error(`Invalid argument ${key}`);
    values[key] = value;
  }
  if (Object.keys(values).some(key => !['--data-root','--output','--duration-hours','--poll-seconds','--case-id'].includes(key))) throw new Error('Unknown argument');
  if (!isAbsolute(values['--data-root'] || '')) throw new Error('--data-root must be absolute');
  if (!isAbsolute(values['--output'] || '')) throw new Error('--output must be absolute');
  const hours = Number(values['--duration-hours']);
  if (!Number.isFinite(hours) || hours < 8 || hours > 12) throw new Error('--duration-hours must be from 8 through 12');
  const seconds = Number(values['--poll-seconds'] || '30');
  if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 300) throw new Error('--poll-seconds must be an integer from 5 through 300');
  const caseIds = (values['--case-id'] || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!caseIds.length) throw new Error('--case-id must name every expected RepairCase');
  return { dataRoot: values['--data-root'], output: values['--output'], durationMs: Math.round(hours * 60 * 60 * 1000), pollMs: seconds * 1000, caseIds };
}

const input = parse(process.argv.slice(2));
const cancellation = new AbortController();
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => cancellation.abort(new Error(`soak interrupted by ${signal}`)));
const writeCheckpoint = (report: Record<string, unknown>) => {
  const temporary = `${input.output}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, input.output);
};
const readAudit = (final: boolean) => {
  const adminPath = join(input.dataRoot, 'admin-management.db'), businessPath = join(input.dataRoot, 'loop-ui.db');
  if (!existsSync(adminPath)) throw new Error(`Missing independent management database: ${adminPath}`);
  const admin = new Database(adminPath, { readonly: true, fileMustExist: true });
  const business = existsSync(businessPath) ? new Database(businessPath, { readonly: true, fileMustExist: true }) : undefined;
  try { return auditRecoveryAcceptance(admin, business, { requiredCaseIds: final ? input.caseIds : [] }); }
  finally { business?.close(); admin.close(); }
};

try {
  const result = await runRecoverySoak({ ...input, requiredCaseIds: input.caseIds, readAudit, writeCheckpoint, signal: cancellation.signal });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`recovery-soak-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
}
