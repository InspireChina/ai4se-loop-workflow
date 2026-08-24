import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Bot,
  Check,
  CircleDot,
  FileClock,
  GitBranch,
  Lightbulb,
  ListFilter,
  UserRound,
} from 'lucide-react';
import { answerDecisionQuestionAction, submitDecisionAnswersAction } from '../actions';
import { decisionAlignmentQuestions, decisionAnswerText } from '../../src/application/decision-alignment';
import { formatEventTime } from '../../src/application/event-time';
import { getTask, type Question } from '../../src/application/tasks';
import { agentLabel, deliveryUnitLabel, terminologyText } from '../../src/domain/terminology';

export const dynamic = 'force-dynamic';

type DecisionView = 'all' | 'mine' | 'agent' | 'answered' | 'audit';
type DecisionSource = 'all' | 'intent' | 'business-design' | 'backlog' | 'analysis';
type DecisionOption = { id: string; label: string; consequences: string[] };
type Activation = { decisionKey: string; optionId: string };

function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function questionStatus(question: Question) {
  if (question.status === 'resolved') return 'RESOLVED';
  if (question.status === 'answered') return 'ANSWERED';
  if (question.status === 'conditional') return 'CONDITIONAL';
  if (question.status === 'not_applicable') return 'INACTIVE';
  if (question.status === 'superseded') return 'SUPERSEDED';
  return 'PENDING';
}

function questionCardClass(question: Question) {
  if (question.status === 'not_applicable' || question.status === 'superseded') return 'inactive';
  if (question.decision_authority === 'agent') return 'agent-resolved';
  if (['answered', 'resolved'].includes(question.status)) return 'user-resolved';
  return 'human-pending';
}

function authorityClass(question: Question) {
  if (question.status === 'not_applicable' || question.status === 'superseded') return 'evidence';
  if (question.decision_authority === 'agent') return 'agent';
  if (['answered', 'resolved'].includes(question.status)) return 'answered';
  return 'human';
}

function viewHref(taskId: string, view: DecisionView, source: DecisionSource, embedded: boolean) {
  const params = new URLSearchParams();
  if (!embedded) params.set('taskId', taskId);
  if (embedded) params.set('section', 'decisions');
  if (view !== 'all') params.set('view', view);
  if (source !== 'all') params.set('source', source);
  const query = params.toString();
  return embedded
    ? `/tasks/${encodeURIComponent(taskId)}${query ? `?${query}` : ''}`
    : `/decisions?${query}`;
}

function visibleForSource(question: Question, source: DecisionSource) {
  if (source === 'intent') return question.source_agent === 'idea-context-agent';
  if (source === 'business-design') return question.source_agent === 'business-design-agent';
  if (source === 'backlog') return question.source_agent === 'backlog-agent';
  if (source === 'analysis') return question.source_agent === 'analyst-agent';
  return true;
}

function visibleForView(question: Question, view: DecisionView) {
  if (view === 'mine') return question.decision_authority === 'human' && question.status === 'pending';
  if (view === 'agent') return question.decision_authority === 'agent' && ['answered', 'resolved'].includes(question.status);
  if (view === 'answered') return question.decision_authority === 'human' && ['answered', 'resolved'].includes(question.status);
  if (view === 'audit') return ['not_applicable', 'superseded'].includes(question.status);
  return question.status !== 'superseded';
}

function orderDecisionTree(questions: Question[]) {
  const children = new Map<string, Question[]>();
  const childIds = new Set<string>();
  for (const question of questions) {
    const activations = parseJsonArray<Activation>(question.activation_json);
    const dependencies = parseJsonArray<string>(question.depends_on_json);
    const parentKey = activations[0]?.decisionKey || dependencies[0];
    if (!parentKey) continue;
    childIds.add(question.question_id);
    children.set(parentKey, [...(children.get(parentKey) || []), question]);
  }
  const ordered: Question[] = [];
  const visited = new Set<string>();
  const visit = (question: Question) => {
    if (visited.has(question.question_id)) return;
    visited.add(question.question_id);
    ordered.push(question);
    for (const child of children.get(question.decision_key || '') || []) visit(child);
  };
  for (const question of questions) {
    if (!childIds.has(question.question_id)) visit(question);
  }
  for (const question of questions) visit(question);
  return ordered;
}

function DecisionCard({
  question,
  taskId,
  questionByKey,
  embedded,
}: {
  question: Question;
  taskId: string;
  questionByKey: Map<string, Question>;
  embedded: boolean;
}) {
  const options = parseJsonArray<DecisionOption>(question.alternatives_json);
  const activations = parseJsonArray<Activation>(question.activation_json);
  const dependencies = parseJsonArray<string>(question.depends_on_json);
  const selectedOption = options.find((option) => option.id === question.selected_option_id);
  const canAnswer = question.decision_authority === 'human' && question.status === 'pending';
  const nested = activations.length > 0 || dependencies.length > 0;
  const branchText = activations.length
    ? activations.map((activation) => {
        const parent = questionByKey.get(activation.decisionKey);
        const parentOptions = parseJsonArray<DecisionOption>(parent?.alternatives_json || null);
        const option = parentOptions.find((item) => item.id === activation.optionId);
        return `「${terminologyText(parent?.title || '上游决策')}」选择「${terminologyText(option?.label || '指定选项')}」`;
      }).join(' 且 ')
    : dependencies.length
      ? `依赖${dependencies.map((key) => `「${terminologyText(questionByKey.get(key)?.title || '上游决策')}」`).join('、')}`
      : null;

  return <>
    {branchText && <div className="decision-demo-branch">
      <span/><GitBranch size={14}/><em>当 {branchText} 时适用</em>
    </div>}
    <article className={`decision-demo-card ${questionCardClass(question)}${nested ? ' nested' : ''}`}>
      <div className="decision-demo-card-head">
        <div className={`decision-demo-authority ${authorityClass(question)}`}>
          {question.decision_authority === 'agent' ? <Bot size={14}/> : <UserRound size={14}/>}
          <b>{question.decision_authority === 'agent' ? 'AGENT' : 'HUMAN'}</b>
          <span>{questionStatus(question)}</span>
        </div>
      </div>
      <div className="decision-demo-card-body">
        <p className="eyebrow">{terminologyText(question.title)} · {deliveryUnitLabel(question.story_index)}</p>
        <h2>{terminologyText(question.question)}</h2>
        {question.why && <p className="decision-demo-impact">{terminologyText(question.why)}</p>}

        {canAnswer && <>
          {options.length > 0 && <div className="decision-demo-options">
            {options.map((option) => {
              const recommended = question.recommendation === option.label;
              return <form action={answerDecisionQuestionAction} className="decision-demo-option-form" key={option.id}>
                <input type="hidden" name="taskId" value={taskId}/>
                <input type="hidden" name="questionId" value={question.question_id}/>
                <input type="hidden" name="selectedOptionId" value={option.id}/>
                {embedded && <input type="hidden" name="returnTo" value="task-detail"/>}
                <button type="submit" className={`decision-demo-option${recommended ? ' recommended' : ''}`}>
                  <span className="decision-demo-radio"/>
                  <span>
                    <strong>{option.label}</strong>
                    {option.consequences.length > 0 && <small>{option.consequences.join('；')}</small>}
                  </span>
                  {recommended && <span className="decision-demo-recommended"><Lightbulb size={12}/>推荐</span>}
                </button>
              </form>;
            })}
          </div>}
          <form action={answerDecisionQuestionAction} className="decision-demo-custom-answer">
            <input type="hidden" name="taskId" value={taskId}/>
            <input type="hidden" name="questionId" value={question.question_id}/>
            {embedded && <input type="hidden" name="returnTo" value="task-detail"/>}
            <label>
              <strong>{options.length ? '自定义答案' : '填写答案'}</strong>
              <small>{options.length ? '输入不在现有选项中的业务规则，后续分支将由负责 Agent 重新判断。' : '填写需要负责 Agent 纳入上下文的明确决定。'}</small>
              <textarea name="answer" required placeholder="输入你的决定和必要的业务边界…"/>
            </label>
            <button type="submit" className="button secondary">保存自定义答案</button>
          </form>
          {question.recommendation && <div className="decision-demo-reason"><Lightbulb size={15}/><div>
            <b>推荐：{terminologyText(question.recommendation)}</b>
            {question.recommendation_reason && <span>{terminologyText(question.recommendation_reason)}</span>}
          </div></div>}
        </>}

        {!canAnswer && question.answer && ['answered', 'resolved'].includes(question.status) && <div className="decision-demo-inline-evidence">
          <b>{question.decision_authority === 'agent' ? 'Agent 决策' : '用户答案'}</b>
          <span>{decisionAnswerText(question.answer, selectedOption?.consequences || [])}</span>
        </div>}
        {!canAnswer && !question.answer && question.status === 'conditional' && <div className="decision-demo-inline-evidence"><b>等待上游</b><span>{question.status_reason || '上游决策完成后才可回答。'}</span></div>}
        {!canAnswer && ['not_applicable', 'superseded'].includes(question.status) && <div className="decision-demo-inline-evidence"><b>{question.status === 'superseded' ? '已失效' : '当前不适用'}</b><span>{question.status_reason || '当前有效决策路径未命中此节点。'}</span></div>}
      </div>
      <footer>
        <span><GitBranch size={13}/>{nested ? branchText : '根决策 · 始终适用'}</span>
        <span>来源：{agentLabel(question.source_agent)} · v{question.spec_revision}</span>
      </footer>
    </article>
  </>;
}

export default async function DecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ taskId?: string | string[]; view?: string | string[]; source?: string | string[]; embedded?: string | string[] }>;
}) {
  const params = await searchParams;
  const taskId = typeof params.taskId === 'string' ? params.taskId : null;
  if (!taskId) notFound();
  const embedded = params.embedded === 'task';
  const detail = await getTask(taskId);
  if (!detail) notFound();

  const requestedView = typeof params.view === 'string' ? params.view : 'all';
  const view: DecisionView = ['mine', 'agent', 'answered', 'audit'].includes(requestedView)
    ? requestedView as DecisionView
    : 'all';
  const requestedSource = typeof params.source === 'string' ? params.source : 'all';
  const requestedDecisionSource: DecisionSource = ['intent', 'business-design', 'backlog', 'analysis'].includes(requestedSource)
    ? requestedSource as DecisionSource
    : 'all';
  const { task, events, lanes } = detail;
  const questions = decisionAlignmentQuestions(detail.questions, detail.deliverySpecs);
  const sourceFilters = ([
    { id: 'intent', label: '需求意图 Agent' },
    { id: 'business-design', label: '业务方案 Agent' },
    { id: 'backlog', label: '需求梳理 Agent' },
    { id: 'analysis', label: '交付分析 Agent' },
  ] as const).filter((filter) => questions.some((question) => visibleForSource(question, filter.id)));
  const source: DecisionSource = requestedDecisionSource !== 'all'
    && !sourceFilters.some((filter) => filter.id === requestedDecisionSource)
    ? 'all'
    : requestedDecisionSource;
  const sourceQuestions = questions.filter((question) => visibleForSource(question, source));
  const orderedQuestions = orderDecisionTree(sourceQuestions);
  const questionByKey = new Map(
    questions
      .filter((question) => question.decision_key)
      .map((question) => [question.decision_key!, question]),
  );
  const allHumanPending = questions.filter((question) => question.decision_authority === 'human' && question.status === 'pending');
  const humanPending = sourceQuestions.filter((question) => question.decision_authority === 'human' && question.status === 'pending');
  const agentResolved = sourceQuestions.filter((question) => question.decision_authority === 'agent' && ['answered', 'resolved'].includes(question.status));
  const humanResolved = sourceQuestions.filter((question) => question.decision_authority === 'human' && ['answered', 'resolved'].includes(question.status));
  const historical = sourceQuestions.filter((question) => ['not_applicable', 'superseded'].includes(question.status));
  const current = orderedQuestions.filter((question) => question.status !== 'superseded');
  const visibleQuestions = orderedQuestions.filter((question) => visibleForView(question, view));
  const version = Math.max(1, ...sourceQuestions.map((question) => question.spec_revision));
  const analysisLane = lanes.find((lane) => lane.lane === 'analysis');
  const waitingForControlAnswers = task.run_state === 'waiting_for_answers'
    && ['idea-context-agent', 'business-design-agent', 'backlog-agent', 'repro-agent', 'feedback-agent'].includes(task.current_subagent || '');
  const waitingForAnswers = waitingForControlAnswers || analysisLane?.status === 'waiting_for_answers';
  const targetAgent = waitingForControlAnswers ? task.current_subagent : analysisLane?.current_agent || 'analyst-agent';
  const auditEvents = events.filter((event) => ['ClarificationRequested', 'QuestionAnswered', 'RequirementClarificationsResolved'].includes(event.event_type)).slice(0, 5);
  const viewTitle = view === 'mine' ? '需要我决策' : view === 'agent' ? 'Agent 已处理' : view === 'answered' ? '用户已决定' : view === 'audit' ? '失效与未命中节点' : '全部当前决策';
  const sourceTitle = source === 'intent' ? '需求意图 Agent'
    : source === 'business-design' ? '业务方案 Agent'
      : source === 'backlog' ? '需求梳理 Agent'
        : source === 'analysis' ? '交付分析 Agent'
          : '全部来源';

  return <div className={`decision-demo-page${embedded ? ' embedded' : ''}`}>
    {!embedded && <header className="decision-demo-header">
      <div>
        <Link href={`/tasks/${encodeURIComponent(taskId)}`} className="decision-demo-back"><ArrowLeft size={14}/>返回需求详情</Link>
        <p className="eyebrow">DECISION ALIGNMENT · TASK LEVEL</p>
        <h1>决策对齐</h1>
        <p className="muted">{task.title} · 展示真实决策树、责任归属和审计状态</p>
      </div>
      <span className="decision-demo-static"><CircleDot size={13}/>实时任务数据</span>
    </header>}

    <section className="decision-demo-metrics">
      <div><span className="decision-demo-metric-icon human"><UserRound size={17}/></span><small>需要我决策</small><b>{humanPending.length}</b></div>
      <div><span className="decision-demo-metric-icon agent"><Bot size={17}/></span><small>Agent 已处理</small><b>{agentResolved.length}</b></div>
      <div><span className="decision-demo-metric-icon answered"><Check size={17}/></span><small>用户已决定</small><b>{humanResolved.length}</b></div>
      <div><span className="decision-demo-metric-icon audit"><FileClock size={17}/></span><small>失效或未命中</small><b>{historical.length}</b></div>
    </section>

    <section className="decision-demo-toolbar card">
      <nav className="decision-demo-tabs" aria-label="决策筛选">
        <Link className={view === 'mine' ? 'active' : ''} href={viewHref(taskId, 'mine', source, embedded)}>需要我决策 <b>{humanPending.length}</b></Link>
        <Link className={view === 'agent' ? 'active' : ''} href={viewHref(taskId, 'agent', source, embedded)}>Agent 已处理 <b>{agentResolved.length}</b></Link>
        <Link className={view === 'answered' ? 'active' : ''} href={viewHref(taskId, 'answered', source, embedded)}>用户已决定 <b>{humanResolved.length}</b></Link>
        <Link className={view === 'all' ? 'active' : ''} href={viewHref(taskId, 'all', source, embedded)}>全部当前 <b>{current.length}</b></Link>
        <Link className={view === 'audit' ? 'active' : ''} href={viewHref(taskId, 'audit', source, embedded)}>失效分支 <b>{historical.length}</b></Link>
      </nav>
      <div className="decision-demo-filter-row">
        <span className="decision-demo-filter-label"><ListFilter size={14}/>当前视图：{viewTitle}</span>
        <nav className="decision-demo-source-filter" aria-label="决策来源筛选">
          <Link className={source === 'all' ? 'active' : ''} href={viewHref(taskId, view, 'all', embedded)}>全部来源</Link>
          {sourceFilters.map((filter) => <Link
            className={source === filter.id ? 'active' : ''}
            href={viewHref(taskId, view, filter.id, embedded)}
            key={filter.id}
          >{filter.label}</Link>)}
        </nav>
        <span className="decision-demo-version">{sourceTitle} · 决策图 v{version} · {sourceQuestions.length} 个节点</span>
      </div>
    </section>

    <div className="decision-demo-layout">
      <main className="decision-demo-list">
        <section className="decision-demo-section-head">
          <div><ListFilter size={16}/><strong>{viewTitle}</strong></div>
          <small>按创建和依赖顺序排列 · 人工决策可操作 · 其他节点只读</small>
        </section>
        {visibleQuestions.length === 0
          ? <div className="card empty">当前筛选下没有决策节点。</div>
          : visibleQuestions.map((question) => <DecisionCard
            question={question}
            taskId={taskId}
            questionByKey={questionByKey}
            embedded={embedded}
            key={question.question_id}
          />)}

        {waitingForAnswers && <div className="decision-demo-submit card">
          <div>
            <strong>{allHumanPending.length ? `当前还有 ${allHumanPending.length} 项需要你决策` : '当前适用决策均已回答'}</strong>
            <small>{allHumanPending.length ? '逐项保存后，完成所有当前适用问题再提交整批答案。' : '提交后会把完整有效决策树交回负责 Agent。'}</small>
          </div>
          {allHumanPending.length === 0
            ? <form action={submitDecisionAnswersAction}>
              <input type="hidden" name="taskId" value={taskId}/>
              {embedded && <input type="hidden" name="returnTo" value="task-detail"/>}
              <button type="submit" className="button success">提交本批决策并交回 {agentLabel(targetAgent)}</button>
            </form>
            : <span className="button disabled" aria-disabled="true">尚有未回答决策</span>}
        </div>}
      </main>

      <aside className="decision-demo-side">
        <section className="card decision-demo-path">
          <div className="decision-demo-side-head"><GitBranch size={16}/><div><strong>当前决策路径</strong><small>按依赖关系生成</small></div></div>
          {current.length === 0 ? <div className="empty">尚无决策节点。</div> : current.map((question, index) => <div key={question.question_id}>
            {index > 0 && <div className={`decision-demo-path-line${question.activation_json ? '' : ' faint'}`}/>}
            <div className={`decision-demo-path-item${question.status === 'pending' ? ' active' : question.status === 'conditional' ? ' conditional' : ['answered', 'resolved'].includes(question.status) ? ' resolved' : ''}`}>
              <span>{['answered', 'resolved'].includes(question.status) ? <Check size={12}/> : index + 1}</span>
              <div><b>{terminologyText(question.title)}</b><small>{questionStatus(question)} · {question.decision_authority === 'agent' ? 'Agent' : '用户'}</small></div>
            </div>
          </div>)}
        </section>

        <section className="card decision-demo-legend">
          <div className="decision-demo-side-head"><ListFilter size={16}/><div><strong>责任与状态</strong><small>标签与颜色同时区分</small></div></div>
          <ul>
            <li><span className="legend-dot human"/><div><b>HUMAN · PENDING</b><small>需要用户选择或自定义回答</small></div></li>
            <li><span className="legend-dot agent"/><div><b>AGENT · RESOLVED</b><small>Agent 在职责范围内关闭</small></div></li>
            <li><span className="legend-dot answered"/><div><b>HUMAN · RESOLVED</b><small>已经纳入上下文的用户决定</small></div></li>
            <li><span className="legend-dot evidence"/><div><b>INACTIVE / SUPERSEDED</b><small>未命中或已被取代，不交给 Agent 判断</small></div></li>
          </ul>
        </section>

        <section className="card decision-demo-audit">
          <div className="decision-demo-side-head"><FileClock size={16}/><div><strong>审计摘要</strong><small>当前版本 v{version}</small></div></div>
          {auditEvents.length === 0 ? <div className="empty">暂无决策审计事件。</div> : auditEvents.map((event) => <div key={event.event_id}>
            <span/><p><b>{agentLabel(event.actor)}</b>{terminologyText(event.summary)}<small>{formatEventTime(event.created_at)}</small></p>
          </div>)}
          <Link className="decision-demo-audit-link" href={viewHref(taskId, 'audit', source, embedded)}><FileClock size={13}/>查看失效分支与被取代节点</Link>
        </section>

        <section className="decision-demo-note">
          <Bot size={16}/><p><b>决策与事实分开</b><br/>这里只记录会关闭实质分支的判断。Actual、Expected 和代码证据继续留在需求上下文文档中。</p>
        </section>
      </aside>
    </div>
  </div>;
}
