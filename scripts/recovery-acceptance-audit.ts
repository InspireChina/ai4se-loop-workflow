import Database from 'better-sqlite3';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { auditRecoveryAcceptance } from '../src/infrastructure/recovery-acceptance-audit';

function options(args: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || Object.hasOwn(parsed, key)) throw new Error(`Invalid argument ${key}`);
    parsed[key] = value;
  }
  if (!parsed['--data-root'] || !isAbsolute(parsed['--data-root'])) throw new Error('--data-root must be an absolute isolated runtime data root');
  if (parsed['--output'] && !isAbsolute(parsed['--output'])) throw new Error('--output must be absolute');
  if (Object.keys(parsed).some(key => !['--data-root', '--output', '--expect', '--case-id'].includes(key))) throw new Error('Unknown argument');
  if (parsed['--expect'] && !['running', 'stopped'].includes(parsed['--expect'])) throw new Error('--expect must be running or stopped');
  return parsed;
}

const parsed = options(process.argv.slice(2));
const dataRoot = parsed['--data-root'];
const adminPath = join(dataRoot, 'admin-management.db');
const businessPath = join(dataRoot, 'loop-ui.db');
if (!existsSync(adminPath)) throw new Error(`Missing independent management database: ${adminPath}`);
const admin = new Database(adminPath, { readonly: true, fileMustExist: true });
const business = existsSync(businessPath) ? new Database(businessPath, { readonly: true, fileMustExist: true }) : undefined;
try {
  const requiredCaseIds = parsed['--case-id'] ? parsed['--case-id'].split(',').map(value => value.trim()).filter(Boolean) : [];
  const result = auditRecoveryAcceptance(admin, business, { expectStopped: parsed['--expect'] === 'stopped', requiredCaseIds });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (parsed['--output']) {
    const temporary = `${parsed['--output']}.${process.pid}.tmp`;
    writeFileSync(temporary, output, { mode: 0o600 });
    renameSync(temporary, parsed['--output']);
  }
  process.stdout.write(output);
  if (!result.passed) process.exitCode = 2;
} finally { business?.close(); admin.close(); }
