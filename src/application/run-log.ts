import { agentLabel, deliveryUnitLabel, flowLabel } from '../domain/terminology';

export type ParsedRunLog = {
  timestamp: string;
  kind: 'run' | 'dispatch' | 'agent' | 'tool' | 'executor' | 'error' | 'raw';
  status: 'info' | 'running' | 'success' | 'error';
  title: string;
  detail: string;
  meta: Record<string, string>;
  raw: string;
};

function parseMeta(text: string) {
  const meta: Record<string, string> = {};
  for (const match of text.matchAll(/(\w+)=("[^"]+"|\S+)/g)) meta[match[1]] = match[2].replace(/^"|"$/g, '');
  meta.requirement ||= meta.task || '';
  meta.unit ||= meta.story || '';
  meta.flow ||= meta.pipeline || '';
  return meta;
}

function stringify(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function compact(value: string, limit = 220) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function stripLogPrefix(body: string) {
  const dashIndex = body.indexOf(' - ');
  if (dashIndex >= 0) return body.slice(dashIndex + 3);
  return body.replace(/^.*?\s-\s*/, '').replace(/^.*?：/, '');
}

function isCursorDiagnostic(text: string) {
  return /^cursor-retrieval:\s+tracing to\b/.test(text.trim());
}

function friendlyCursorDiagnostic(text: string) {
  if (isCursorDiagnostic(text)) return `Cursor retrieval 已开启诊断 trace（非错误）：${text.replace(/^cursor-retrieval:\s*/, '')}`;
  return text;
}

function toolNameLabel(tool: string) {
  const lower = tool.toLowerCase();
  if (lower === 'agent-command') return 'Agent 领域命令';
  if (lower.includes('shell')) return 'Shell 命令';
  if (lower.includes('grep')) return '搜索';
  if (lower.includes('glob')) return '文件匹配';
  if (lower.includes('read')) return '读取文件';
  if (lower.includes('edit')) return '编辑文件';
  if (lower.includes('write')) return '写入文件';
  return tool || '工具';
}

function summarizeCommand(command: string) {
  if (!command) return '';
  const normalized = command.replace(/["']/g, '');
  const unescaped = command.replace(/\\(["'])/g, '$1');
  if (/(?:^|[/\\])loop-agent\.mjs(?:["']|\s)/.test(unescaped)) {
    if (normalized.includes(' requirement-context status')) return '恢复需求上下文草稿';
    if (normalized.includes(' requirement-context goal set')) return '保存需求目标';
    if (normalized.includes(' requirement-context outcome set')) return '保存用户可观察结果';
    if (normalized.includes(' requirement-context classification set')) return '保存需求分类';
    if (normalized.includes(' requirement-context fact ')) return '更新已确认事实';
    if (normalized.includes(' requirement-context constraint ')) return '更新需求约束';
    if (normalized.includes(' requirement-context scope ')) return '更新范围边界';
    if (normalized.includes(' requirement-context question ')) return '更新澄清问题';
    if (normalized.includes(' requirement-context validate')) return '校验需求上下文草稿';
    if (normalized.includes(' requirement-context request-clarification')) return '提交澄清请求';
    if (normalized.includes(' requirement-context complete')) return '完成需求上下文';
    if (normalized.includes(' delivery-plan status')) return '恢复交付计划草稿';
    if (normalized.includes(' delivery-plan rationale set')) return '保存交付拆分依据';
    if (normalized.includes(' delivery-plan coverage set')) return '保存交付覆盖说明';
    if (normalized.includes(' delivery-plan ordering set')) return '保存交付排序说明';
    if (normalized.includes(' delivery-plan unit upsert')) return '保存交付单元';
    if (normalized.includes(' delivery-plan unit remove')) return '删除交付单元';
    if (normalized.includes(' delivery-plan unit move')) return '调整交付单元顺序';
    if (normalized.includes(' delivery-plan validate')) return '校验交付计划草稿';
    if (normalized.includes(' delivery-plan complete')) return '完成交付计划';
    if (normalized.includes(' reproduction status')) return '恢复问题复现草稿';
    if (normalized.includes(' reproduction expected set')) return '保存预期行为';
    if (normalized.includes(' reproduction actual set')) return '保存实际行为';
    if (normalized.includes(' reproduction environment set')) return '保存复现环境';
    if (normalized.includes(' reproduction stability set')) return '保存稳定性与对照结论';
    if (normalized.includes(' reproduction impact set')) return '保存最小影响范围';
    if (normalized.includes(' reproduction step ')) return '更新复现步骤';
    if (normalized.includes(' reproduction evidence ')) return '更新复现证据';
    if (normalized.includes(' reproduction hypothesis ')) return '更新根因假设';
    if (normalized.includes(' reproduction question ')) return '更新人工对齐问题';
    if (normalized.includes(' reproduction validate')) return '校验问题复现草稿';
    if (normalized.includes(' reproduction request-alignment')) return '提交人工对齐请求';
    if (normalized.includes(' reproduction complete')) return '完成问题复现';
    if (normalized.includes(' analysis status')) return '恢复方案规格草稿';
    if (normalized.includes(' analysis goal set')) return '保存交付单元目标';
    if (normalized.includes(' analysis scope ')) return '更新方案范围';
    if (normalized.includes(' analysis behavior ')) return '更新用户可观察行为';
    if (normalized.includes(' analysis decision option-')) return '更新决策选项';
    if (normalized.includes(' analysis decision recommend')) return '更新决策推荐';
    if (normalized.includes(' analysis decision depends-')) return '更新决策依赖';
    if (normalized.includes(' analysis decision resolve')) return '解决关键决策';
    if (normalized.includes(' analysis decision reopen')) return '重新打开关键决策';
    if (normalized.includes(' analysis decision ')) return '更新关键决策';
    if (normalized.includes(' analysis criterion ')) return '更新验收标准';
    if (normalized.includes(' analysis verification ')) return '更新验证计划';
    if (normalized.includes(' analysis dependency ')) return '更新方案依赖';
    if (normalized.includes(' analysis budget ')) return '更新 Change Budget';
    if (normalized.includes(' analysis validate')) return '校验方案规格草稿';
    if (normalized.includes(' analysis request-clarification')) return '提交方案澄清问题';
    if (normalized.includes(' analysis complete')) return '完成方案分析';
    if (normalized.includes(' implementation status')) return '恢复开发实现草稿';
    if (normalized.includes(' implementation summary set')) return '保存开发结论';
    if (normalized.includes(' implementation assessment set')) return '保存走查模式';
    if (normalized.includes(' implementation notes set')) return '保存实现说明';
    if (normalized.includes(' implementation criterion ')) return '更新验收覆盖';
    if (normalized.includes(' implementation change ')) return '更新代码变更';
    if (normalized.includes(' implementation test ')) return '更新验证记录';
    if (normalized.includes(' implementation risk ')) return '更新残余风险';
    if (normalized.includes(' implementation runtime-input ')) return '更新运行信息请求';
    if (normalized.includes(' implementation recovery ')) return '更新恢复事项';
    if (normalized.includes(' implementation commit set')) return '记录开发提交';
    if (normalized.includes(' implementation failure set')) return '记录开发失败';
    if (normalized.includes(' implementation validate')) return '校验开发实现草稿';
    if (normalized.includes(' implementation request-input')) return '提交运行信息请求';
    if (normalized.includes(' implementation complete')) return '完成开发实现';
    if (normalized.includes(' implementation fail')) return '提交开发失败';
    if (normalized.includes(' verification status')) return '恢复验证草稿';
    if (normalized.includes(' verification summary set')) return '保存验证结论';
    if (normalized.includes(' verification criterion ')) return '更新验收证据';
    if (normalized.includes(' verification check ')) return '更新独立检查';
    if (normalized.includes(' verification risk ')) return '更新验证风险';
    if (normalized.includes(' verification failure set')) return '保存失败归因';
    if (normalized.includes(' verification failure clear')) return '清除失败归因';
    if (normalized.includes(' verification runtime-input ')) return '更新验证运行信息';
    if (normalized.includes(' verification recovery ')) return '更新恢复验证';
    if (normalized.includes(' verification request-input')) return '提交验证运行信息请求';
    if (normalized.includes(' verification pass')) return '提交验证通过';
    if (normalized.includes(' verification fail')) return '提交验证失败回流';
    if (normalized.includes(' verification block')) return '提交验证阻塞';
    if (normalized.includes(' feedback status')) return '恢复反馈草稿';
    if (normalized.includes(' feedback summary set')) return '保存反馈处理摘要';
    if (normalized.includes(' feedback group ')) return '更新反馈工作组';
    if (normalized.includes(' feedback question ')) return '更新反馈澄清问题';
    if (normalized.includes(' feedback verification reason set')) return '保存反馈验证理由';
    if (normalized.includes(' feedback evidence ')) return '更新反馈验证证据';
    if (normalized.includes(' feedback triage-complete')) return '提交反馈批次分流';
    if (normalized.includes(' feedback request-clarification')) return '提交反馈澄清问题';
    if (normalized.includes(' feedback resolve')) return '提交反馈已满足';
    if (normalized.includes(' feedback reopen')) return '提交反馈重新处理';
    if (normalized.includes(' review status')) return '恢复结卡报告草稿';
    if (normalized.includes(' review title set')) return '保存结卡报告标题';
    if (normalized.includes(' review summary set')) return '保存结卡摘要';
    if (normalized.includes(' review section ')) return '更新结卡报告章节';
    if (normalized.includes(' review evidence ')) return '更新结卡可追溯证据';
    if (normalized.includes(' review runtime-input ')) return '更新结卡运行信息';
    if (normalized.includes(' review complete')) return '提交结卡报告';
    if (normalized.includes(' review request-input')) return '提交结卡运行信息请求';
    if (normalized.includes(' help')) return '查看当前 Agent 可用命令';
    return '更新 Agent 工作草稿';
  }
  if (command.includes(' agent-context ')) return '按需读取执行上下文';
  if (command.includes(' task-get ') || command.includes(' task-show ')) return '查询需求详情';
  if (command.includes(' task-context-init ')) return '初始化需求上下文';
  if (command.includes(' task-update ')) return '更新需求状态';
  if (command.includes(' paths')) return '查看工作区路径配置';
  if (command.includes('--help')) return '查看 loopctl 可用命令';
  return compact(command);
}

function extractToolEventFromJson(text: string) {
  const jsonText = text.includes(' - ') ? text.slice(text.indexOf(' - ') + 3) : text;
  if (!jsonText.trim().startsWith('{')) return null;
  try {
    const event = JSON.parse(jsonText) as Record<string, unknown>;
    const toolCall = event.tool_call as Record<string, unknown> | undefined;
    if (!toolCall && event.type !== 'tool_call') return null;
    const key = toolCall ? Object.keys(toolCall).find((item) => item.endsWith('ToolCall')) : '';
    const payload = key ? toolCall?.[key] as Record<string, unknown> | undefined : undefined;
    const args = payload?.args as Record<string, unknown> | undefined;
    const result = payload?.result as Record<string, unknown> | undefined;
    const tool = key ? key.replace(/ToolCall$/, '') : '';
    const subtype = String(event.subtype || '');
    const command = stringify(args?.command);
    const description = stringify(args?.description);
    const path = stringify(args?.path || args?.targetDirectory);
    const pattern = stringify(args?.pattern || args?.globPattern);
    let detail = description || summarizeCommand(command) || [path, pattern].filter(Boolean).join(' · ') || '执行工具';
    let status: ParsedRunLog['status'] = subtype === 'completed' ? 'success' : 'running';
    if (subtype === 'completed') {
      const success = result?.success as Record<string, unknown> | undefined;
      const error = result?.error as Record<string, unknown> | undefined;
      if (error) {
        status = 'error';
        detail = `失败：${compact(stringify(error))}`;
      } else if (success) {
        const exitCode = success.exitCode !== undefined ? `exit=${success.exitCode}` : '';
        const stdout = stringify(success.stdout);
        const files = Array.isArray(success.files) ? `匹配 ${success.files.length} 个文件` : '';
        const content = stringify(success.content);
        const resultText = stdout ? `输出 ${stdout.split(/\r?\n/).filter(Boolean).length} 行` : files || (content ? `读取 ${String(success.totalLines || '').trim() || '若干'} 行` : '执行成功');
        detail = [exitCode, resultText].filter(Boolean).join('，');
      } else {
        detail = '执行完成';
      }
    }
    return { tool, subtype, status, detail };
  } catch {
    if (!jsonText.includes('"type":"tool_call"')) return null;
    const subtype = jsonText.match(/"subtype":"([^"]+)"/)?.[1] || '';
    const tool = (jsonText.match(/"(\w+ToolCall)"/)?.[1] || '').replace(/ToolCall$/, '');
    const description = jsonText.match(/"description":"([^"]+)"/)?.[1];
    const command = jsonText.match(/"command":"([^"]+)"/)?.[1] || '';
    const path = jsonText.match(/"path":"([^"]+)"/)?.[1] || jsonText.match(/"targetDirectory":"([^"]+)"/)?.[1] || '';
    const pattern = jsonText.match(/"pattern":"([^"]+)"/)?.[1] || jsonText.match(/"globPattern":"([^"]+)"/)?.[1] || '';
    const exitCode = jsonText.match(/"exitCode":(\d+)/)?.[1];
    const detail = subtype === 'completed'
      ? [exitCode ? `exit=${exitCode}` : '', '执行完成'].filter(Boolean).join('，')
      : description || summarizeCommand(command) || [path, pattern].filter(Boolean).join(' · ') || '执行工具';
    return { tool, subtype, status: subtype === 'completed' ? 'success' as const : 'running' as const, detail: compact(detail) };
  }
}

function splitLogLine(line: string) {
  const match = line.match(/^(\S+)\s+\[([^\]]+)]\s*(.*)$/);
  if (!match) return null;
  return { timestamp: match[1], label: match[2], body: match[3] };
}

export function parseRunLogLine(line: string): ParsedRunLog | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parsed = splitLogLine(trimmed);
  if (!parsed) return { timestamp: '', kind: 'raw', status: 'info', title: '原始日志', detail: trimmed, meta: {}, raw: trimmed };
  const meta = parseMeta(parsed.body);
  const base = { timestamp: parsed.timestamp, meta, raw: trimmed };

  if (parsed.label === '运行') {
    return { ...base, kind: 'run', status: parsed.body.includes('结束') ? 'success' : 'running', title: parsed.body.includes('结束') ? '运行结束' : '运行状态', detail: parsed.body };
  }
  if (parsed.label === '派发') {
    const title = parsed.body.startsWith('#') ? `安排给 ${agentLabel(meta.agent)}` : '生成推进计划';
    const detail = parsed.body.startsWith('#')
      ? [meta.requirement, meta.unit && meta.unit !== '-' ? deliveryUnitLabel(Number(meta.unit)) : '', meta.flow ? flowLabel(meta.flow) : ''].filter(Boolean).join(' · ')
      : parsed.body;
    return { ...base, kind: 'dispatch', status: 'info', title, detail };
  }
  if (parsed.label === 'Agent') {
    const isComplete = parsed.body.startsWith('完成 ');
    const isStart = parsed.body.startsWith('开始 ');
    const isBlocked = parsed.body.startsWith('阻塞 ');
    const title = isComplete ? `${agentLabel(meta.agent)} 完成` : isStart ? `${agentLabel(meta.agent)} 开始` : `${agentLabel(meta.agent)} 进展`;
    const status = isComplete ? 'success' : isBlocked ? 'error' : 'running';
    return { ...base, kind: 'agent', status, title, detail: stripLogPrefix(parsed.body) };
  }
  if (parsed.label === '工具调用' || parsed.label === '工具结果') {
    return { ...base, kind: 'tool', status: parsed.label === '工具结果' ? 'success' : 'running', title: `${agentLabel(meta.agent)} ${parsed.label}`, detail: stripLogPrefix(parsed.body) };
  }
  if (parsed.label === '执行器工具' || parsed.label === 'Cursor工具') {
    const detailBody = stripLogPrefix(parsed.body).replace(/^(?:调用|完成)：/, '');
    const extracted = extractToolEventFromJson(detailBody);
    if (extracted) {
      return {
        ...base,
        kind: 'tool',
        status: extracted.status,
        title: `${extracted.subtype === 'completed' ? '完成' : '调用'} ${toolNameLabel(extracted.tool)}`,
        detail: extracted.detail,
        meta: { ...meta, tool: extracted.tool },
      };
    }
    const isDone = parsed.body.includes('完成');
    const tool = meta.tool || '工具';
    return { ...base, kind: 'tool', status: isDone ? 'success' : 'running', title: `${isDone ? '完成' : '调用'} ${toolNameLabel(tool)}`, detail: detailBody };
  }
  if (parsed.label === '执行器输出' || parsed.label === 'Cursor输出') {
    if (parsed.body.includes('type=user')) return null;
    const detail = stripLogPrefix(parsed.body).replace(/^type=\w+\s*-\s*/, '');
    if (detail.trim().startsWith('{')) {
      try {
        const content = JSON.parse(detail).content as { text?: string }[] | undefined;
        const text = content?.map((item) => item.text).filter(Boolean).join('\n');
        if (text) return { ...base, kind: 'executor', status: 'info', title: 'Agent 输出', detail: compact(text, 500) };
      } catch {
        return null;
      }
    }
    return { ...base, kind: 'executor', status: 'info', title: 'Agent 思考', detail };
  }
  if (parsed.label === '执行器事件' || parsed.label === 'Cursor事件') {
    if (parsed.body.includes('"type":"system"') || parsed.body.includes('"subtype":"completed"')) return null;
  }
  if (parsed.label === '执行器警告'
    && /codex_core_plugins::manifest: ignoring interface\.defaultPrompt: maximum of \d+ prompts is supported/.test(parsed.body)) return null;
  if (parsed.label === '执行器警告') {
    return { ...base, kind: 'executor', status: 'info', title: `${meta.executor || 'Agent'} 警告`, detail: parsed.body };
  }
  if (parsed.label === '执行器诊断' || parsed.label === 'Cursor诊断') {
    return { ...base, kind: 'executor', status: 'info', title: `${meta.executor || 'Cursor'} 诊断`, detail: friendlyCursorDiagnostic(parsed.body) };
  }
  if (parsed.label === 'Cursor错误' && isCursorDiagnostic(parsed.body)) {
    return { ...base, kind: 'executor', status: 'info', title: 'Cursor 诊断', detail: friendlyCursorDiagnostic(parsed.body) };
  }
  if (parsed.label === '执行器错误' && (
    /Reading additional input from stdin/.test(parsed.body)
    || /codex_core_skills::loader: ignoring interface\.icon_(?:small|large)/.test(parsed.body)
    || /codex_core_plugins::manifest: ignoring interface\.defaultPrompt: maximum of \d+ prompts is supported/.test(parsed.body)
  )) return null;
  if (parsed.label === '执行器错误' && /(?:^|\s)WARN(?:ING)?(?:\s|:)/i.test(parsed.body)) {
    return { ...base, kind: 'executor', status: 'info', title: `${meta.executor || 'Agent'} 警告`, detail: parsed.body };
  }
  if (parsed.label === '执行器错误' || parsed.label === 'Cursor错误' || parsed.label === '错误') {
    return { ...base, kind: 'error', status: 'error', title: '运行错误', detail: parsed.body };
  }
  if (parsed.label === '执行器' || parsed.label === 'Cursor') {
    const executor = meta.executor ? `${meta.executor[0].toUpperCase()}${meta.executor.slice(1)}` : 'Cursor';
    return { ...base, kind: 'executor', status: parsed.body.includes('退出') ? 'success' : 'info', title: `${executor} CLI`, detail: parsed.body };
  }
  return { ...base, kind: 'raw', status: 'info', title: parsed.label, detail: parsed.body };
}

export function parseRunLog(content: string) {
  return content.split(/\r?\n/).map(parseRunLogLine).filter((item): item is ParsedRunLog => Boolean(item));
}
