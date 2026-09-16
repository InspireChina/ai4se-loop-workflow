import type { AdminCommandCredential } from '../domain/admin-command';
import type { AdminManagementStore } from '../infrastructure/admin-management-store';
import { isAdminHistoryCollection } from '../domain/admin-history';

function parseOptions(args: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`无效命令参数：${key}`);
    if (Object.hasOwn(options, key)) throw new Error(`重复参数：${key}`);
    options[key] = value;
  }
  return options;
}

export function runAdminCommand(store: AdminManagementStore, credential: AdminCommandCredential, args: string[]) {
  if (args.length === 1 && args[0] === 'status') return JSON.stringify(store.commandStatus(credential), null, 2);
  if (args[0] === 'history' && args[1] === 'read') {
    const options = parseOptions(args.slice(2));
    const collection = options['--collection'];
    if (Object.keys(options).some(key => !['--collection','--index','--start','--length','--hash'].includes(key))
      || !collection || !isAdminHistoryCollection(collection)
      || ![options['--index'], options['--start'], options['--length']].every(value => value && /^\d+$/.test(value))) {
      throw new Error('history read 必须提供 --collection observations/evidence/attempts/followups/diagnoses --index --start --length');
    }
    return JSON.stringify(store.commandReadHistory(credential, collection, Number(options['--index']),
      Number(options['--start']), Number(options['--length']), options['--hash']), null, 2);
  }
  if (args[0] === 'workspace' && args[1] === 'takeover') {
    const options = parseOptions(args.slice(2));
    if (Object.keys(options).some(key => !['--key','--item-id','--revision','--reason'].includes(key))
      || !options['--key'] || !options['--item-id'] || !options['--revision'] || !options['--reason']) {
      throw new Error('workspace takeover 必须提供 --key --item-id --revision --reason');
    }
    return JSON.stringify(store.commandRequestAction(credential, options['--key'], {
      kind: 'workspace-takeover', itemId: options['--item-id'], itemRevision: Number(options['--revision']), reason: options['--reason'],
    }), null, 2);
  }
  if (args[0] === 'harness' && args[1] === 'workspace') {
    const options=parseOptions(args.slice(2));
    if(Object.keys(options).some(key=>!['--key','--observation-id','--reason'].includes(key))
      ||!options['--key']||!options['--observation-id']||!options['--reason'])throw new Error('harness workspace 必须提供 --key --observation-id --reason');
    return JSON.stringify(store.commandRequestAction(credential,options['--key'],{
      kind:'harness-workspace',observationId:options['--observation-id'],reason:options['--reason'],
    }),null,2);
  }
  if(args[0]==='harness'&&args[1]==='build'){
    const options=parseOptions(args.slice(2));
    if(Object.keys(options).some(key=>!['--key','--workspace-key','--reason'].includes(key))
      ||!options['--key']||!options['--workspace-key']||!options['--reason'])throw new Error('harness build 必须提供 --key --workspace-key --reason');
    return JSON.stringify(store.commandRequestAction(credential,options['--key'],{
      kind:'harness-build',workspaceKey:options['--workspace-key'],reason:options['--reason'],
    }),null,2);
  }
  if (args[0] === 'evidence' && args[1] === 'record') {
    const options = parseOptions(args.slice(2));
    if (Object.keys(options).some(key => !['--key', '--kind', '--payload'].includes(key))) throw new Error('evidence record 包含未知参数');
    if (!options['--key'] || !options['--kind'] || !options['--payload']) throw new Error('evidence record 必须提供 --key --kind --payload');
    if (!['hypothesis', 'finding', 'action', 'change'].includes(options['--kind'])) throw new Error('--kind 必须为 hypothesis/finding/action/change');
    const payload: unknown = JSON.parse(options['--payload']);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('--payload 必须是 JSON 对象');
    const inserted = store.commandRecordEvidence(credential, options['--key'], options['--kind'], payload as Record<string, unknown>);
    return `Outcome: ${inserted ? 'recorded' : 'already-recorded'}`;
  }
  if (args[0] === 'submit') {
    const options = parseOptions(args.slice(1));
    if (Object.keys(options).some(key => key !== '--result') || !options['--result']) throw new Error('submit 必须提供 --result <JSON>');
    const submitted = store.commandSubmit(credential, JSON.parse(options['--result']));
    return `Outcome: ${submitted ? 'submitted' : 'already-submitted'}; independent verification is required before closure`;
  }
  throw new Error('Admin 命令仅支持 status、history read、workspace takeover、harness workspace/build、evidence record、submit；不能直接完成 Dev/Test 或关闭 Case');
}
