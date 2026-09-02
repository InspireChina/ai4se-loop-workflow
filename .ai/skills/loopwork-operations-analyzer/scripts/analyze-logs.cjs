#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { mkdir, writeFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { homedir, tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

function loadDatabaseDriver() {
  try {
    return require('better-sqlite3');
  } catch (sourceError) {
    const installRoot = resolve(__dirname, '..', '..', '..', '..');
    const appRoot = process.env.LOOP_APP_ROOT || (process.platform === 'darwin'
      ? join(installRoot, 'Resources', 'app-server')
      : join(installRoot, 'resources', 'app-server'));
    try {
      return createRequire(join(appRoot, 'package.json'))('better-sqlite3');
    } catch {
      throw new Error(`无法加载随 LoopWork 打包的 SQLite 驱动；请使用 LOOP_DESKTOP_NODE 运行。${sourceError.message}`);
    }
  }
}

const Database = loadDatabaseDriver();

function usage() {
  return `Usage: analyze-logs.cjs [options]

  --db <path>          精确的 loop-ui.db 路径
  --data-root <path>   LoopWork data 目录
  --workspace <path>   已配置的工作区根目录
  --days <number>      UTC 回看天数，默认 30
  --output-dir <path>  输出目录，默认使用系统临时目录
  --help               显示帮助`;
}

function parseArgs(args) {
  const options = { days: 30 };
  const names = new Set(['--db', '--data-root', '--workspace', '--days', '--output-dir']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') return { ...options, help: true };
    if (!names.has(argument)) throw new Error(`未知参数：${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
    index += 1;
  }
  options.days = Number(options.days);
  if (!Number.isFinite(options.days) || options.days <= 0 || options.days > 3650) {
    throw new Error('--days 必须在 1 到 3650 之间');
  }
  return options;
}

function defaultDataRoot() {
  if (process.env.LOOP_DATA_ROOT) return resolve(process.env.LOOP_DATA_ROOT);
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'loopwork-desktop', 'data');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'loopwork-desktop', 'data');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'loopwork-desktop', 'data');
}

function readonlyDatabase(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

function configuredWorkspace(dataRoot) {
  const path = join(dataRoot, 'loopwork.db');
  if (!existsSync(path)) return null;
  const db = readonlyDatabase(path);
  try {
    const row = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'workspace_root'").get();
    return typeof row?.setting_value === 'string' ? row.setting_value : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function locateDatabase(options) {
  if (options.db) {
    const dbPath = resolve(options.db);
    if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
    return { dbPath, workspace: options.workspace ? resolve(options.workspace) : null };
  }
  const dataRoot = resolve(options.dataRoot || defaultDataRoot());
  const workspace = resolve(options.workspace || configuredWorkspace(dataRoot) || process.cwd());
  const workspaceHash = createHash('sha1').update(workspace).digest('hex').slice(0, 12);
  const dbPath = join(dataRoot, workspaceHash, 'loop-ui.db');
  if (!existsSync(dbPath)) {
    throw new Error(`工作区 ${workspace} 对应的数据库不存在：${dbPath}。请显式传入 --db 或 --workspace`);
  }
  return { dbPath, workspace };
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableColumns(db, table) {
  if (!hasTable(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function columnOr(available, name, fallback = 'NULL') {
  return available.has(name) ? name : `${fallback} AS ${name}`;
}

function redact(value, limit = 320) {
  return String(value || '')
    .replace(/(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/[A-Za-z0-9_-]{48,}/g, '<redacted-token>')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

function tokenize(command) {
  return command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

const GENERIC_NAMESPACES = new Set([
  'status', 'help', 'whoami', 'delivery-unit', 'delivery-spec', 'artifact', 'decision',
  'acceptance', 'check', 'runtime-input', 'metadata', 'phase', 'draft', 'schema', 'direct',
]);

function parseDomainCommand(command) {
  const tokens = tokenize(command);
  const executable = tokens.findIndex((token) => /loop-agent\.(?:mjs|cjs)$/i.test(token.replaceAll('\\', '/')));
  if (executable < 0) return null;
  const args = tokens.slice(executable + 1);
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) {
      flags.set(args[index], args[index + 1] || '');
      index += 1;
    } else {
      positionals.push(args[index]);
    }
  }
  if (!positionals.length) return null;
  const protocol = GENERIC_NAMESPACES.has(positionals[0]) ? 'generic-yaml' : 'legacy';
  let family = positionals.slice(0, protocol === 'legacy' ? 3 : 2).join(' ');
  if (positionals[0] === 'artifact' && positionals[1] === 'put') {
    family += ` ${flags.get('--artifact') || '?'}:${flags.get('--block') || '?'}`;
  }
  return { protocol, family };
}

function grouped(rows, selector) {
  const counts = new Map();
  for (const row of rows) {
    const value = selector(row) || '(none)';
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function loadExecutions(db, cutoff) {
  if (!hasTable(db, 'execution_attempts')) return [];
  const available = tableColumns(db, 'execution_attempts');
  return db.prepare(`
    SELECT execution_id, run_id, task_id, agent, pipeline, attempt, status,
           ${columnOr(available, 'failure_kind')}, ${columnOr(available, 'last_error')},
           ${columnOr(available, 'dispatch_generation_key')}, created_at,
           ${columnOr(available, 'finished_at')}
    FROM execution_attempts
    WHERE created_at >= ?
    ORDER BY created_at, execution_id
  `).all(cutoff);
}

function loadCommands(db, cutoff, executions) {
  if (!hasTable(db, 'execution_receipts')) return [];
  const executionById = new Map(executions.map((row) => [row.execution_id, row]));
  const receipts = db.prepare(`
    SELECT execution_id, receipt_key, payload_json, created_at
    FROM execution_receipts
    WHERE kind = 'tool_event' AND created_at >= ?
    ORDER BY created_at, execution_id, receipt_key
  `).all(cutoff);
  const commands = [];
  for (const receipt of receipts) {
    try {
      const payload = JSON.parse(receipt.payload_json);
      if (payload.phase !== 'completed') continue;
      const parsed = parseDomainCommand(typeof payload.input?.command === 'string' ? payload.input.command : '');
      if (!parsed) continue;
      const execution = executionById.get(receipt.execution_id);
      commands.push({
        executionId: receipt.execution_id,
        executionStatus: execution?.status || '(unknown)',
        agent: execution?.agent || '(unknown)',
        protocol: parsed.protocol,
        family: `${execution?.agent || '(unknown)'}::${parsed.family}`,
        success: payload.success === true,
        outcome: payload.commandOutcome || (String(payload.summary || '').match(/- Outcome:\s*([^\s]+)/i)?.[1] || ''),
        errorCode: payload.commandErrorCode || (String(payload.summary || '').match(/- Error-Code:\s*([^\s]+)/i)?.[1] || ''),
        errorPath: payload.commandErrorPath || (String(payload.summary || '').match(/- Error-Path:\s*([^\r\n]+)/i)?.[1] || ''),
        summary: redact(payload.summary || payload.statusMessage || ''),
        createdAt: receipt.created_at,
      });
    } catch {
      // A malformed telemetry row must not abort the remaining read-only analysis.
    }
  }
  return commands;
}

function correctedGroups(commands) {
  const groups = new Map();
  for (const command of commands) {
    const key = `${command.executionId}\u0000${command.family}`;
    const state = groups.get(key) || { ...command, rejected: false, corrected: false };
    if (!command.success) state.rejected = true;
    else if (state.rejected) state.corrected = true;
    state.executionStatus = command.executionStatus;
    groups.set(key, state);
  }
  return [...groups.values()].filter((state) => state.corrected);
}

function loadRuntimeErrors(db, cutoff) {
  if (!hasTable(db, 'runtime_events')) return [];
  const available = tableColumns(db, 'runtime_events');
  return db.prepare(`
    SELECT event_name, component, severity_text, body,
           ${columnOr(available, 'exception_fingerprint')},
           ${columnOr(available, 'exception_message')}
    FROM runtime_events
    WHERE timestamp >= ? AND severity_number >= 13
    ORDER BY timestamp
  `).all(cutoff).map((row) => ({ ...row, message: redact(row.exception_message || row.body) }));
}

function loadLoopRuns(db, cutoff) {
  if (!hasTable(db, 'loop_runs')) return [];
  return db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM loop_runs WHERE started_at >= ?
    GROUP BY status ORDER BY count DESC
  `).all(cutoff);
}

function percent(value, total) {
  return total ? `${(value * 100 / total).toFixed(1)}%` : 'n/a';
}

function table(headers, rows) {
  if (!rows.length) return '_无数据_';
  const safe = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${headers.map(safe).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(safe).join(' | ')} |`),
  ].join('\n');
}

function report(facts) {
  const rejected = facts.commands.completed - facts.commands.succeeded;
  return [
    '# LoopWork 运维分析底稿', '',
    `- 数据库：\`${facts.database.path}\``,
    `- 工作区：${facts.database.workspace ? `\`${facts.database.workspace}\`` : '未确认'}`,
    `- UTC 时间窗：${facts.window.cutoff} 至 ${facts.window.generatedAt}`,
    `- 最新 migration：${facts.database.latestMigration || 'unknown'}`, '',
    '## 总览', '',
    table(['指标', '数值'], [
      ['Execution', facts.executions.total],
      ['Attempt > 1', facts.executions.attemptGreaterThanOne],
      ['Attempt > 1 且最终 applied', `${facts.executions.retriedApplied}（${percent(facts.executions.retriedApplied, facts.executions.attemptGreaterThanOne)}）`],
      ['内部命令 completed', facts.commands.completed],
      ['内部命令 rejected/failed', `${rejected}（${percent(rejected, facts.commands.completed)}）`],
      ['同 execution 同命令族自纠正', facts.commands.selfCorrected],
      ['自纠正后 execution 仍失败或阻塞', facts.commands.correctedButExecutionFailed],
    ]), '',
    '## Execution 状态', '',
    table(['状态', '数量'], facts.executions.byStatus.map((row) => [row.name, row.count])), '',
    '## Failure Kind', '',
    table(['Failure Kind', '数量'], facts.executions.byFailureKind.map((row) => [row.name, row.count])), '',
    '## 命令协议', '',
    table(['协议形态', 'completed'], facts.commands.byProtocol.map((row) => [row.name, row.count])), '',
    '> legacy 与 generic-yaml 必须分别分析；跨协议总量不能证明当前版本仍有同一问题。', '',
    '## 高频失败命令族', '',
    table(['Agent::命令族', '失败', '成功', '自纠正'], facts.commands.topFamilies.map((row) => [row.family, row.failed, row.succeeded, row.selfCorrected])), '',
    '## 命令拒绝原因', '',
    table(['错误码', '数量'], facts.commands.byErrorCode.map((row) => [row.name, row.count])), '',
    '## Runtime 错误指纹', '',
    table(['指纹/事件', '数量', '示例'], facts.runtimeErrors.top.map((row) => [row.name, row.count, row.example])), '',
    '## Loop Run 状态', '',
    table(['状态', '数量'], facts.loopRuns.map((row) => [row.status, row.count])), '',
    '## 下一步', '',
    '- 对高频命令族抽取 rejected 回执，检查动态 schema、合法枚举和纠正模板。',
    '- 对“自纠正后仍失败”的 execution 核对最终 failure_kind，不要默认命令拒绝造成重试。',
    '- 将机械协议问题修在 Harness/命令回执，将 Provider、Runner 和业务判断问题分别归因。',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return void process.stdout.write(`${usage()}\n`);
  const database = locateDatabase(options);
  const cutoff = new Date(Date.now() - options.days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  const db = readonlyDatabase(database.dbPath);
  let facts;
  try {
    const executions = loadExecutions(db, cutoff);
    const commands = loadCommands(db, cutoff, executions);
    const corrections = correctedGroups(commands);
    const families = new Map();
    for (const command of commands) {
      const row = families.get(command.family) || { family: command.family, failed: 0, succeeded: 0, selfCorrected: 0 };
      if (command.success) row.succeeded += 1;
      else row.failed += 1;
      families.set(command.family, row);
    }
    for (const correction of corrections) families.get(correction.family).selfCorrected += 1;
    const runtimeErrors = loadRuntimeErrors(db, cutoff);
    const runtimeGroups = new Map();
    for (const error of runtimeErrors) {
      const key = error.exception_fingerprint || `${error.component}:${error.event_name}:${error.message}`;
      const row = runtimeGroups.get(key) || { name: key, count: 0, example: error.message };
      row.count += 1;
      runtimeGroups.set(key, row);
    }
    const latestMigration = hasTable(db, 'schema_migrations')
      ? db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get()?.name || null
      : null;
    facts = {
      database: { path: database.dbPath, workspace: database.workspace, latestMigration },
      window: { days: options.days, cutoff, generatedAt: new Date().toISOString() },
      executions: {
        total: executions.length,
        attemptGreaterThanOne: executions.filter((row) => Number(row.attempt) > 1).length,
        retriedApplied: executions.filter((row) => Number(row.attempt) > 1 && row.status === 'applied').length,
        byStatus: grouped(executions, (row) => row.status),
        byFailureKind: grouped(executions.filter((row) => row.failure_kind), (row) => row.failure_kind),
      },
      commands: {
        completed: commands.length,
        succeeded: commands.filter((row) => row.success).length,
        selfCorrected: corrections.length,
        correctedButExecutionFailed: corrections.filter((row) => ['retryable_failed', 'system_blocked'].includes(row.executionStatus)).length,
        byProtocol: grouped(commands, (row) => row.protocol),
        byErrorCode: grouped(commands.filter((row) => !row.success), (row) => row.errorCode || '(unclassified)'),
        topFamilies: [...families.values()].filter((row) => row.failed)
          .sort((left, right) => right.failed - left.failed || left.family.localeCompare(right.family)).slice(0, 25),
      },
      runtimeErrors: {
        total: runtimeErrors.length,
        top: [...runtimeGroups.values()].sort((left, right) => right.count - left.count).slice(0, 20),
      },
      loopRuns: loadLoopRuns(db, cutoff),
    };
  } finally {
    db.close();
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDirectory = resolve(options.outputDir || join(tmpdir(), 'loopwork-operations', stamp));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`, 'utf8');
  await writeFile(join(outputDirectory, 'report.md'), `${report(facts)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputDirectory, report: join(outputDirectory, 'report.md'), facts: join(outputDirectory, 'facts.json') })}\n`);
}

main().catch((error) => {
  process.stderr.write(`loopwork-operations-analyzer: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
