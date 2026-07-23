#!/usr/bin/env tsx
import '../load-env.js';
import { readFile } from 'node:fs/promises';
import {
  addQuestion,
  addStory,
  cancelTask,
  createLoopDispatch,
  createTask,
  ensureLoopRuntimeFiles,
  getRunStatus,
  getTask,
  getTaskContext,
  getDocument,
  initializeTaskContext,
  listDocuments,
  listTasks,
  pipelineForTask,
  releaseBlock,
  rewindTask,
  toJsonlEnvelope,
  toPipeEnvelope,
  transitionTask,
  updateTask,
  upsertDocument,
} from '../../src/application/tasks';
import { databaseConnection, paths } from '../../src/infrastructure/database';
import type { Actor, TaskStatus } from '../../src/domain/task';
import type { TaskLaneKind } from '../../src/application/task-lanes';
import {
  getExecutionAgentContextSnapshot,
  renderAgentContextEvidence,
  renderAgentContextHistory,
  renderAgentContextList,
  renderAgentContextOverview,
  renderAgentContextResource,
  renderAgentContextSearch,
} from '../../src/application/agent-context';

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

async function jsonArg(args: Args) {
  const inline = optional(args, 'json');
  if (inline) return JSON.parse(inline) as Record<string, unknown>;
  const file = optional(args, 'jsonFile');
  if (file) return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  return null;
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
  for (const lane of detail.lanes) console.log(`lane.${lane.lane}: ${lane.status} agent=${lane.current_agent || ''} story=${lane.current_story_index || ''} reason=${lane.blocked_reason || ''}`);
}

async function printTaskList(args: Args) {
  const includeTerminal = boolArg(args, 'all');
  const status = optional(args, 'status');
  const limit = Number(optional(args, 'limit') || 50);
  const tasks = (await listTasks({ includeTerminal })).filter((task) => !status || task.agile_status === status).slice(0, limit);
  for (const task of tasks) {
    const lanes = task.lanes.map((lane) => `${lane.lane}=${lane.status}${lane.current_agent ? `/${lane.current_agent}` : ''}`).join(' ');
    console.log(`${task.task_id} | ${task.agile_status} | ${task.priority || ''} | ${task.title} | ${lanes} | a=${task.analysis_index}/${task.total_stories} d=${task.dev_index} t=${task.test_index} | ${task.next_step || ''}`);
  }
}

async function printTaskUrlList() {
  const tasks = await listTasks({ includeTerminal: true });
  for (const task of tasks.map((item) => item.link).filter(Boolean).sort()) console.log(task);
}

async function printBlockList(format: string) {
  const tasks = (await listTasks({ includeTerminal: true })).filter((task) => task.agile_status === 'blocked' || task.lanes.some((lane) => lane.status === 'system_blocked'));
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
    const blockedLanes = task.lanes.filter((lane) => lane.status === 'system_blocked');
    for (const lane of blockedLanes) {
      console.log(`  - ${lane.lane} Lane: ${lane.current_agent || ''} · ${lane.blocked_reason || ''}`);
      console.log(`    - Operator recovery: npm run loopctl -- system-unblock ${task.task_id} --lane ${lane.lane}`);
    }
    if (!blockedLanes.length && task.agile_status === 'blocked') {
      console.log(`  - Agent: ${task.current_subagent || ''}`);
      console.log(`  - Reason: ${task.blocked_reason || ''}`);
      console.log(`  - Operator recovery: npm run loopctl -- system-unblock ${task.task_id}`);
    }
    console.log(`  - Next Step: ${task.next_step || ''}`);
    console.log('');
  }
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
      taskDescription: task.description,
      itemType: task.item_type,
      priority: task.priority || '',
      link: task.link || '',
      externalId: task.external_id || '',
      externalStatus: task.external_status || '',
      agileStatus: task.agile_status,
      currentSubagent: task.current_subagent || '',
      resumePending: task.resume_pending,
      specResolvedIndex: task.spec_resolved_index,
      runState: task.run_state,
      closureStatus: task.closure_status,
      reviewRevision: task.review_revision,
      reviewDocumentId: task.review_document_id || '',
      lastActor: task.last_actor || '',
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
    case 'run-status': {
      const run = await getRunStatus();
      console.log(run?.active ? `active pid=${run.pid ?? 'starting'} run=${run.runId}` : 'idle');
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
    case 'dispatch': {
      const result = await createLoopDispatch(requireValue(args, 'runToken'));
      console.log(result.runDir);
      return;
    }
    case 'block-list':
      await printBlockList(value(args, 'format', 'markdown'));
      return;
    case 'system-unblock':
    case 'block-release': // legacy operator alias
      {
        const lane = optional(args, 'lane');
        if (lane && lane !== 'analysis' && lane !== 'delivery') throw new Error('--lane must be analysis or delivery');
        await releaseBlock(args._[0], lane as TaskLaneKind | undefined);
        console.log(`system block recovered ${args._[0]}${lane ? ` lane=${lane}` : ''}`);
      }
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
        item_type: optional(args, 'itemType'),
        priority: optional(args, 'priority'),
      });
      console.log(`updated ${taskId}`);
      return;
    }
    case 'story-add':
      await addStory({ taskId: requireValue(args, 'taskId'), title: requireValue(args, 'title'), actor: optional(args, 'actor') || 'human' });
      console.log('story added');
      return;
    case 'task-context':
      console.log(JSON.stringify(await getTaskContext(requireValue(args, 'taskId')), null, 2));
      return;
    case 'agent-context': {
      const executionId = process.env.LOOP_EXECUTION_ID;
      if (!executionId) throw new Error('agent-context 只能在流程 Agent execution 内使用');
      const snapshot = await getExecutionAgentContextSnapshot(executionId);
      const action = args._[0] || 'overview';
      if (action === 'overview') console.log(renderAgentContextOverview(snapshot));
      else if (action === 'list') console.log(renderAgentContextList(snapshot, { kind: optional(args, 'kind'), scope: optional(args, 'scope') }));
      else if (action === 'get') console.log(renderAgentContextResource(snapshot, args._[1] || requireValue(args, 'ref')));
      else if (action === 'search') console.log(renderAgentContextSearch(snapshot, args._[1] || requireValue(args, 'query')));
      else if (action === 'evidence') console.log(renderAgentContextEvidence(snapshot, optional(args, 'stage')));
      else if (action === 'history') console.log(renderAgentContextHistory(snapshot, args._[1] || requireValue(args, 'ref')));
      else throw new Error(`unknown agent-context action: ${action}`);
      return;
    }
    case 'document-upsert': {
      const payload = await jsonArg(args);
      const input = payload || {
        taskId: requireValue(args, 'taskId'),
        storyIndex: optional(args, 'story'),
        kind: requireValue(args, 'kind'),
        title: optional(args, 'title'),
        content: requireValue(args, 'content'),
        format: optional(args, 'format') || 'markdown',
        actor: optional(args, 'actor') || 'human',
      };
      console.log(await upsertDocument(input));
      return;
    }
    case 'document-list':
      console.log(JSON.stringify(await listDocuments(requireValue(args, 'taskId')), null, 2));
      return;
    case 'document-get': {
      const document = await getDocument(requireValue(args, 'taskId'), requireValue(args, 'kind'), numberArg(args, 'story'));
      if (!document) throw new Error('document not found');
      console.log(JSON.stringify(document, null, 2));
      return;
    }
    case 'task-rewind':
      await rewindTask({ taskId: args._[0], actor: requireValue(args, 'actor'), to: requireValue(args, 'to'), story: optional(args, 'story'), reason: optional(args, 'reason') });
      console.log(`rewound ${args._[0]}`);
      return;
    case 'task-cancel':
      await cancelTask({ taskId: args._[0], reason: requireValue(args, 'reason') });
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
        const payload = await jsonArg(args);
        const taskId = String(payload?.taskId || requireValue(args, 'taskId'));
        const detail = await getTask(taskId);
        const agent = String(payload?.actor || detail?.task.current_subagent || '');
        const kind = String(payload?.kind || (agent === 'analyst-agent' ? 'analysis' : agent === 'test-agent' ? 'test' : agent === 'review-agent' ? 'review' : 'local'));
        const questions = Array.isArray(payload?.questions) ? payload.questions as Record<string, unknown>[] : [{
          title: payload?.title || optional(args, 'title') || '待确认问题',
          question: payload?.question || requireValue(args, 'question'),
          why: payload?.why || optional(args, 'why'),
          recommendation: payload?.recommendation || optional(args, 'recommendation'),
        }];
        const ids: string[] = [];
        for (const [index, question] of questions.entries()) {
          ids.push(await addQuestion({
            taskId,
            kind,
            storyIndex: question.storyIndex || payload?.storyIndex || optional(args, 'story'),
            title: question.title || '待确认问题',
            question: question.question,
            why: question.why,
            recommendation: question.recommendation,
            blockedReason: payload?.blockedReason || optional(args, 'blockedReason'),
            blockTask: payload?.blockTask ?? true,
            actor: agent || 'human',
          }));
        }
        console.log(JSON.stringify({ questionIds: ids }));
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
