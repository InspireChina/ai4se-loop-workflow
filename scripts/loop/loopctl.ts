#!/usr/bin/env tsx
import '../load-env.js';
import {
  addQuestion,
  beginRun,
  cancelTask,
  createLoopDispatch,
  createTask,
  endRun,
  ensureLoopRuntimeFiles,
  getRunStatus,
  getTask,
  initializeTaskContext,
  listTasks,
  pipelineAllEnvelopes,
  pipelineForTask,
  releaseBlock,
  requireRunLease,
  rewindTask,
  toJsonlEnvelope,
  toPipeEnvelope,
  transitionTask,
  updateTask,
} from '../../src/application/tasks';
import { databaseConnection, paths } from '../../src/infrastructure/database';
import type { Actor, TaskStatus } from '../../src/domain/task';

type Args = { _: string[]; [key: string]: string | boolean | string[] | undefined };

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function value(args: Args, key: string, fallback = '') {
  const item = args[key];
  return typeof item === 'string' ? item : fallback;
}

function optional(args: Args, key: string) {
  const item = value(args, key);
  return item || undefined;
}

function numberArg(args: Args, key: string) {
  const item = optional(args, key);
  return item ? Number(item) : undefined;
}

function boolArg(args: Args, key: string) {
  return args[key] === true || args[key] === 'true';
}

function itemTypeArg(args: Args) {
  const raw = optional(args, 'itemType') || 'other';
  return raw === 'requirement' ? 'feature' : raw;
}

function requireValue(args: Args, key: string) {
  const item = optional(args, key);
  if (!item) throw new Error(`missing --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
  return item;
}

async function printStatus() {
  const db = await databaseConnection();
  const rows = db.prepare('SELECT agile_status, COUNT(*) AS count FROM tasks GROUP BY agile_status ORDER BY agile_status').all() as { agile_status: string; count: number }[];
  console.log('tasks:');
  for (const row of rows) console.log(`  ${row.agile_status}: ${row.count}`);
}

async function printTask(taskId: string) {
  const detail = await getTask(taskId);
  if (!detail) throw new Error(`task not found: ${taskId}`);
  const task = detail.task;
  for (const [key, item] of Object.entries(task)) console.log(`${key}: ${item ?? ''}`);
}

async function printTaskList(args: Args) {
  const includeTerminal = boolArg(args, 'all');
  const status = optional(args, 'status');
  const limit = Number(optional(args, 'limit') || 50);
  const tasks = (await listTasks({ includeTerminal })).filter((task) => !status || task.agile_status === status).slice(0, limit);
  for (const task of tasks) {
    console.log(`${task.task_id} | ${task.agile_status} | ${task.priority || ''} | ${task.title} | current=${task.current_subagent || ''} | a=${task.analysis_index}/${task.total_stories} d=${task.dev_index} t=${task.test_index} | ${task.next_step || ''}`);
  }
}

async function printTaskUrlList() {
  const tasks = await listTasks({ includeTerminal: true });
  for (const task of tasks.map((item) => item.link).filter(Boolean).sort()) console.log(task);
}

async function printBlockList(format: string) {
  const tasks = (await listTasks({ includeTerminal: true })).filter((task) => task.agile_status === 'blocked');
  if (format === 'jsonl') {
    for (const task of tasks) console.log(JSON.stringify(task));
    return;
  }
  if (!tasks.length) {
    console.log('No active blocked tasks.');
    return;
  }
  console.log('## Blocked Tasks\n');
  for (const task of tasks) {
    console.log(`- ${task.title} (${task.task_id})`);
    console.log(`  - Agent: ${task.current_subagent || ''}`);
    console.log(`  - Work Dir: ${task.work_dir || ''}`);
    console.log(`  - Block File: ${task.work_dir ? `${task.work_dir}/block.md` : `${paths.blocksDir}/${task.task_id}.md`}`);
    if (task.approval_file) console.log(`  - Approval File: ${task.approval_file}`);
    console.log(`  - Reason: ${task.blocked_reason || ''}`);
    console.log(`  - Next Step: ${task.next_step || ''}`);
    console.log(`  - Release: python scripts/loop/loopctl.py block-release ${task.task_id}`);
    console.log('');
  }
}

async function printPipelineAll(args: Args) {
  const runToken = requireValue(args, 'runToken');
  await requireRunLease(runToken);
  const format = value(args, 'format', 'jsonl');
  const lines = await pipelineAllEnvelopes();
  for (const line of lines) console.log(format === 'pipe' ? toPipeEnvelope(line) : toJsonlEnvelope(line));
}

async function printTaskPipeline(taskId: string, args: Args) {
  const detail = await getTask(taskId);
  if (!detail) throw new Error(`task not found: ${taskId}`);
  const format = value(args, 'format', 'jsonl');
  const lines = await pipelineForTask(taskId);
  for (const line of lines) {
    const task = detail.task;
    const envelope = {
      ...line,
      title: task.title,
      itemType: task.item_type,
      priority: task.priority || '',
      link: task.link || '',
      externalId: task.external_id || '',
      externalStatus: task.external_status || '',
      agileStatus: task.agile_status,
      currentSubagent: task.current_subagent || '',
      resumePending: task.resume_pending,
      analysisApprovedIndex: task.analysis_approved_index,
      reviewApproved: task.review_approved,
      approvalFile: task.approval_file || '',
      lastActor: task.last_actor || '',
      workDir: task.work_dir || '',
      analysisIndex: task.analysis_index,
      devIndex: task.dev_index,
      testIndex: task.test_index,
      totalStories: task.total_stories,
      nextStep: task.next_step || '',
      blockedReason: task.blocked_reason || '',
      owner: task.owner || '',
      evidence: task.evidence || '',
      risk: task.risk || '',
    };
    console.log(format === 'pipe' ? toPipeEnvelope(envelope) : toJsonlEnvelope(envelope));
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case 'init':
      await databaseConnection();
      await ensureLoopRuntimeFiles();
      console.log(`initialized ${paths.dbPath}`);
      return;
    case 'paths':
      console.log(JSON.stringify({
        app_root: paths.appRoot,
        workspace_root: paths.root,
        repo_hash: paths.repoHash,
        data_dir: paths.dataDir,
        db_path: paths.dbPath,
        runs_dir: paths.runsDir,
      }, null, 2));
      return;
    case 'status':
      await printStatus();
      return;
    case 'run-begin': {
      const token = await beginRun('loopctl', Number(optional(args, 'leaseMinutes') || 120));
      console.log(token);
      return;
    }
    case 'run-end':
      await endRun(args._[0] || '', boolArg(args, 'force'));
      console.log('loop run released');
      return;
    case 'run-status': {
      const run = await getRunStatus();
      console.log(run?.active ? `active until ${run.leaseUntil}` : run ? 'expired' : 'idle');
      return;
    }
    case 'task-add':
      const taskId = await createTask({
        actor: requireValue(args, 'actor') as Actor,
        taskId: optional(args, 'taskId'),
        title: requireValue(args, 'title'),
        link: optional(args, 'link'),
        externalId: optional(args, 'externalId'),
        externalStatus: optional(args, 'externalStatus'),
        itemType: itemTypeArg(args),
        priority: optional(args, 'priority'),
        status: optional(args, 'status') || 'backlog',
        currentSubagent: optional(args, 'currentSubagent'),
      });
      console.log(taskId);
      return;
    case 'task-list':
      await printTaskList(args);
      return;
    case 'task-url-list':
      await printTaskUrlList();
      return;
    case 'task-get':
      await printTask(args._[0]);
      return;
    case 'task-pipeline':
      await printTaskPipeline(args._[0], args);
      return;
    case 'pipeline-all':
      await printPipelineAll(args);
      return;
    case 'dispatch': {
      const result = await createLoopDispatch(requireValue(args, 'runToken'));
      console.log(result.runDir);
      return;
    }
    case 'block-list':
      await printBlockList(value(args, 'format', 'markdown'));
      return;
    case 'block-release':
      await releaseBlock(args._[0]);
      console.log(`released ${args._[0]}`);
      return;
    case 'task-update': {
      const taskId = args._[0];
      await updateTask(taskId, requireValue(args, 'actor') as Actor, {
        title: optional(args, 'title'),
        agile_status: optional(args, 'status') as TaskStatus | undefined,
        current_subagent: optional(args, 'currentSubagent'),
        analysis_index: numberArg(args, 'analysisIndex'),
        dev_index: numberArg(args, 'devIndex'),
        test_index: numberArg(args, 'testIndex'),
        total_stories: numberArg(args, 'totalStories'),
        next_step: optional(args, 'nextStep'),
        blocked_reason: optional(args, 'blockedReason'),
        work_dir: optional(args, 'workDir'),
        item_type: optional(args, 'itemType'),
        priority: optional(args, 'priority'),
        approval_file: optional(args, 'approvalFile'),
      });
      console.log(`updated ${taskId}`);
      return;
    }
    case 'task-rewind':
      await rewindTask({ taskId: args._[0], actor: requireValue(args, 'actor'), to: requireValue(args, 'to'), story: optional(args, 'story'), reason: optional(args, 'reason') });
      console.log(`rewound ${args._[0]}`);
      return;
    case 'task-cancel':
      await cancelTask({ taskId: args._[0], reason: requireValue(args, 'reason'), confirmCodeClean: boolArg(args, 'confirmCodeClean') });
      console.log(`cancelled ${args._[0]}`);
      return;
    case 'task-context-init':
      console.log(await initializeTaskContext({
        taskId: args._[0],
        actor: requireValue(args, 'actor'),
        kind: optional(args, 'kind') || 'intake',
        slug: optional(args, 'slug'),
        status: optional(args, 'status'),
        currentSubagent: optional(args, 'currentSubagent'),
        nextStep: optional(args, 'nextStep'),
        blockedReason: optional(args, 'blockedReason'),
      }));
      return;
    case 'question-add':
      {
        const taskId = requireValue(args, 'taskId');
        const detail = await getTask(taskId);
        const agent = detail?.task.current_subagent || '';
        const kind = agent === 'analyst-agent' ? 'analysis' : agent === 'test-agent' ? 'test' : agent === 'review-agent' ? 'review' : 'local';
        console.log(await addQuestion({
          taskId,
          kind,
          title: optional(args, 'title') || '待确认问题',
          question: requireValue(args, 'question'),
          why: optional(args, 'why'),
          recommendation: optional(args, 'recommendation'),
          blockedReason: optional(args, 'blockedReason'),
          blockTask: true,
        }));
      }
      return;
    default:
      throw new Error(`unknown command: ${command || ''}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
