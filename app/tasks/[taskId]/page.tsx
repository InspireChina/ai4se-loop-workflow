import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, Check, CheckCircle2, Clock3, FileText, GitBranch } from 'lucide-react';
import { formatEventTime } from '../../../src/application/event-time';
import { getTask, pipelineForTask } from '../../../src/application/tasks';
import { getTaskContextChat } from '../../../src/application/task-context-chat';
import { agentLabel, confirmationKindLabel, deliveryUnitLabel, documentKindLabel, flowLabel, itemTypeLabel, statusLabel, terminologyText } from '../../../src/domain/terminology';
import { ArtifactDocument } from './artifact-document';
import { TaskAutoRefresh } from './task-auto-refresh';
import { TaskContextChat } from './task-context-chat';
import {
  acknowledgeClosureAction,
  addStoryAction,
  answerQuestionAction,
  answerRuntimeInputAction,
  cancelTaskAction,
  releaseBlockAction,
  submitClarificationAnswersAction,
  submitRuntimeInputsAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

const standardTaskSteps = [
  { label: '需求整理', statuses: ['backlog'] },
  { label: '交付拆分', statuses: ['in plan'] },
  { label: '单元推进', statuses: ['ready for dev', 'in dev'] },
  { label: '整体验收', statuses: ['in review'] },
  { label: '阅读结卡', statuses: ['ready_to_close'] },
  { label: '完成', statuses: ['done'] },
] as const;

const bugTaskSteps = [
  { label: '需求整理', statuses: ['backlog'] },
  { label: '问题复现', statuses: ['in repro'] },
  ...standardTaskSteps.slice(1),
] as const;

function stepDetail(task: { agile_status: string; run_state: string; current_subagent: string | null; analysis_index: number; dev_index: number; test_index: number; total_stories: number }, lanes: { lane: string; status: string; current_agent: string | null }[]) {
  const laneAttention = lanes.filter((lane) => ['waiting_for_answers', 'waiting_for_runtime_input', 'system_blocked'].includes(lane.status));
  if (laneAttention.length) return laneAttention.map((lane) => {
    const laneName = lane.lane === 'analysis' ? 'Analysis' : 'Delivery';
    const state = lane.status === 'waiting_for_answers' ? '等待澄清' : lane.status === 'waiting_for_runtime_input' ? '等待运行信息' : '系统阻塞';
    return `${laneName} ${state} · ${agentLabel(lane.current_agent)}`;
  }).join('；');
  if (task.run_state === 'waiting_for_answers') return `等待需求级澄清 · ${agentLabel(task.current_subagent)}`;
  if (task.run_state === 'waiting_for_runtime_input') return `等待补充运行信息 · ${agentLabel(task.current_subagent)}`;
  if (task.agile_status === 'blocked') return `系统异常已暂停 · ${agentLabel(task.current_subagent)}`;
  if (task.agile_status === 'backlog') return '正在收集上下文';
  if (task.agile_status === 'in repro') return '正在复现并定位问题';
  if (task.agile_status === 'in plan') return '正在拆分交付单元';
  if (task.agile_status === 'ready for dev') return '准备逐个推进交付单元';
  if (task.agile_status === 'in dev') return `分析 ${task.analysis_index}/${task.total_stories} · 实现 ${task.dev_index}/${task.total_stories} · 验证 ${task.test_index}/${task.total_stories}`;
  if (task.agile_status === 'in review') return '正在进行整体验收';
  if (task.agile_status === 'ready_to_close') return '结卡报告已生成，等待阅读';
  if (task.agile_status === 'done') return '需求已完成交付';
  return '需求已取消';
}

function laneStatusLabel(status: string) {
  return ({
    pending: '等待上游', runnable: '可运行', running: '运行中',
    waiting_for_answers: '等待澄清', waiting_for_runtime_input: '等待运行信息',
    system_blocked: '系统阻塞', completed: '已完成',
  } as Record<string, string>)[status] || status;
}

export default async function TaskDetail({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const detail = await getTask(taskId);
  if (!detail) notFound();
  const { task, lanes, stories, storySpecs, questions, runtimeInputs, documents, documentComments, closureAcknowledgements, executionAttempts, events } = detail;
  const analysisLane = lanes.find((lane) => lane.lane === 'analysis')!;
  const deliveryLane = lanes.find((lane) => lane.lane === 'delivery')!;
  const pipeline = await pipelineForTask(taskId);
  const contextChat = await getTaskContextChat(taskId);
  const unansweredQuestions = questions.filter((question) => question.status === 'pending');
  const waitingForControlAnswers = task.run_state === 'waiting_for_answers'
    && (task.current_subagent === 'backlog-agent' || task.current_subagent === 'repro-agent');
  const waitingForAnswers = waitingForControlAnswers || analysisLane.status === 'waiting_for_answers';
  const unansweredRuntimeInputs = runtimeInputs.filter((input) => input.status === 'pending');
  const waitingRuntimeLanes = lanes.filter((lane) => lane.status === 'waiting_for_runtime_input');
  const waitingForRuntimeInput = waitingRuntimeLanes.length > 0;
  const blockedLanes = lanes.filter((lane) => lane.status === 'system_blocked');
  const reviewDocument = task.review_document_id ? documents.find((document) => document.document_id === task.review_document_id) : null;
  const blockingFeedback = documentComments.filter((comment) => comment.feedback_status !== 'resolved');
  const deliveryDocuments = documents.filter((document) => document.document_id !== reviewDocument?.document_id);
  const progressStatus = task.agile_status === 'blocked' ? task.resume_status || 'backlog' : task.agile_status;
  const taskSteps = task.item_type === 'bug' || progressStatus === 'in repro' ? bugTaskSteps : standardTaskSteps;
  const currentStep = taskSteps.findIndex((step) => step.statuses.some((status) => status === progressStatus));
  const currentSpecs = storySpecs.filter((spec) => spec.status !== 'superseded');

  return <>
    <header className="task-header">
      <Link className="crumb" href="/tasks">需求</Link>
      <div className="task-title-row">
        <div>
          <p className="eyebrow">{task.task_id}</p>
          <h1>{task.title}</h1>
        </div>
        <span className={`badge ${task.agile_status === 'blocked' || waitingForAnswers || waitingForRuntimeInput || blockedLanes.length ? 'amber' : task.agile_status === 'done' ? 'green' : 'blue'}`}>{waitingForRuntimeInput ? '等待运行信息' : waitingForAnswers ? '等待澄清' : blockedLanes.length ? 'Lane 阻塞' : statusLabel(task.agile_status)}</span>
      </div>
      <div className="chips">
        <TaskAutoRefresh/>
        <span>{itemTypeLabel(task.item_type)}</span>
        <span>{task.priority || '未定级'}</span>
        <span>Analysis · {agentLabel(analysisLane.current_agent)}</span>
        <span>Delivery · {agentLabel(deliveryLane.current_agent)}</span>
        {task.link && <a href={task.link} target="_blank" rel="noreferrer">{task.link}</a>}
      </div>
    </header>

    <section className={`card task-steps ${task.agile_status === 'blocked' ? 'blocked' : task.agile_status === 'done' ? 'done' : ''}`} aria-label="需求当前进度">
      <div className="task-steps-head">
        <strong>推进进度</strong>
        <span>{Math.max(currentStep + 1, 1)} / {taskSteps.length}</span>
      </div>
      <ol style={{ gridTemplateColumns: `repeat(${taskSteps.length}, minmax(0, 1fr))` }}>
        {taskSteps.map((step, index) => {
          const completed = task.agile_status === 'done' ? index <= currentStep : index < currentStep;
          const current = index === currentStep;
          return <li className={[completed ? 'completed' : '', current ? 'current' : ''].filter(Boolean).join(' ')} aria-current={current ? 'step' : undefined} key={step.label}>
            <span className="step-marker">{completed ? <Check size={15}/> : index + 1}</span>
            <span className="step-copy">
              <strong>{step.label}</strong>
            </span>
          </li>;
        })}
      </ol>
      <div className="task-step-caption">
        <span className="caption-dot"/>
        <div>
          <small>{taskSteps[Math.max(currentStep, 0)]?.label}</small>
          <strong>{stepDetail(task, lanes)}</strong>
        </div>
      </div>
    </section>

    <section className="card task-summary">
      <div><small>分析</small><b>{task.analysis_index} / {task.total_stories}</b></div>
      <div><small>实现</small><b>{task.dev_index} / {task.total_stories}</b></div>
      <div><small>验证</small><b>{task.test_index} / {task.total_stories}</b></div>
      <div><small>待回答澄清</small><b>{unansweredQuestions.length}</b></div>
      <div><small>待补充运行信息</small><b>{unansweredRuntimeInputs.length}</b></div>
      <div className="summary-wide"><small>下一步</small><p>{terminologyText(task.next_step) || '—'}</p></div>
      <div className="summary-wide"><small>文档</small><p>{documents.length} 个数据库文档</p></div>
    </section>

    <section className="lane-grid" aria-label="任务并行 Lane 状态">
      {[analysisLane, deliveryLane].map((lane) => <article className={`card lane-card ${lane.status}`} key={lane.lane}>
        <div className="lane-card-head">
          <div>
            <p className="eyebrow">{lane.lane === 'analysis' ? 'Analysis Lane' : 'Delivery Lane'}</p>
            <h2>{lane.lane === 'analysis' ? '规格分析流水线' : '开发验证流水线'}</h2>
          </div>
          <span className={`badge ${lane.status === 'completed' ? 'green' : lane.status.includes('waiting') || lane.status === 'system_blocked' ? 'amber' : 'blue'}`}>{laneStatusLabel(lane.status)}</span>
        </div>
        <div className="lane-progress">
          {lane.lane === 'analysis'
            ? `分析 ${task.analysis_index}/${task.total_stories}`
            : `实现 ${task.dev_index}/${task.total_stories} · 验证 ${task.test_index}/${task.total_stories}`}
        </div>
        <p>{lane.current_agent ? `${agentLabel(lane.current_agent)}${lane.current_story_index ? ` · ${deliveryUnitLabel(lane.current_story_index)}` : ''}` : lane.status === 'pending' ? '等待可消费的上游结果' : '当前没有运行中的 Agent'}</p>
        {lane.blocked_reason && <small>{terminologyText(lane.blocked_reason)}</small>}
      </article>)}
    </section>

    <div className="task-detail-grid">
      <div className="task-main-column">
        <section className="task-section">
          <div className="section-head">
            <h2>交付单元</h2>
            <small>{stories.length ? `${stories.length} 个交付单元` : '尚未拆分'}</small>
          </div>
          <div className="card story-list">
            {stories.length === 0 ? <div className="empty">尚未拆分交付单元。</div> : stories.map((story) => <div className="story" key={story.story_index}>
              <span className={story.story_index <= task.test_index ? 'done' : story.story_index <= task.dev_index ? 'active' : ''}>
                {story.story_index <= task.test_index ? <CheckCircle2 size={16}/> : <Clock3 size={16}/>}
              </span>
              <div>
                <strong>{deliveryUnitLabel(story.story_index)} · {story.title}</strong>
                <small>{story.directory || 'DB'}</small>
              </div>
              <em>{story.story_index <= task.test_index ? '测试完成' : story.story_index <= task.dev_index ? '等待测试' : story.story_index <= task.analysis_index ? '等待开发' : '等待分析'}</em>
            </div>)}
          </div>
          <form action={addStoryAction} className="card form-panel inline-create">
            <input type="hidden" name="taskId" value={task.task_id}/>
            <label>新增交付单元<input name="title" required placeholder="描述可独立验收的最小业务闭环"/></label>
            <button className="button secondary" type="submit">添加</button>
          </form>
        </section>

        <section className="task-section">
          <div>
            <div className="section-head"><h2>交付文档</h2><small>{deliveryDocuments.length} 个文档 · {documentComments.filter((comment) => comment.feedback_status !== 'resolved').length} 条待处理反馈</small></div>
            <div className="card document-list">{deliveryDocuments.length === 0 ? <div className="empty">还没有数据库文档。</div> : deliveryDocuments.map((document) => <details key={document.document_id} className="document-item">
              <summary><FileText size={15}/><span>{terminologyText(document.title)}</span><small>{[documentKindLabel(document.kind), deliveryUnitLabel(document.story_index), agentLabel(document.source_agent)].filter(Boolean).join(' · ')}</small></summary>
              <ArtifactDocument
                taskId={task.task_id}
                documentId={document.document_id}
                content={document.content}
                format={document.format}
                revision={document.revision}
                comments={documentComments.filter((comment) => comment.document_id === document.document_id)}
                allowReopen={task.agile_status !== 'done'}
                allowComment={task.agile_status !== 'done'}
              />
            </details>)}</div>
          </div>
        </section>

        <section className="task-section">
          <div className="section-head">
            <h2>交付规格</h2>
            <small>{currentSpecs.length} 个当前规格</small>
          </div>
          <div className="card document-list">
            {currentSpecs.length === 0 ? <div className="empty">方案分析完成后会在这里显示版本化 Slice Spec，验证证据由 Test Agent 写入交付文档。</div> : <>
              {currentSpecs.map((spec) => {
                const parsed = JSON.parse(spec.spec_json) as {
                  goal: string;
                  decisionTree?: {
                    key: string;
                    question: string;
                    status: 'resolved_from_context' | 'needs_user_input';
                    selectedOption?: string;
                    source?: 'code' | 'user' | 'convention';
                    evidence?: string[];
                  }[];
                  ambiguities: { key: string; description: string }[];
                  acceptanceCriteria: { id: string; description: string; oracle: string }[];
                  changeBudget: { capabilities: string[]; paths: string[] };
                };
                return <details key={spec.spec_id} className="document-item" open={spec.status === 'waiting_for_answers'}>
                  <summary><FileText size={15}/><span>{deliveryUnitLabel(spec.story_index)} · Slice Spec v{spec.revision}</span><small>{spec.status === 'resolved' ? '歧义已归零' : '等待设计决策'}</small></summary>
                  <div className="answer"><b>目标：</b>{parsed.goal}</div>
                  {!!parsed.decisionTree?.length && <pre>{parsed.decisionTree.map((item) => [
                    `${item.key}: ${item.question}`,
                    item.status === 'resolved_from_context'
                      ? `已从上下文确定：${item.selectedOption} · 来源 ${item.source}${item.evidence?.length ? `\n证据：${item.evidence.join('；')}` : ''}`
                      : '等待用户决策',
                  ].join('\n')).join('\n\n')}</pre>}
                  {parsed.ambiguities.length > 0 && <pre>{parsed.ambiguities.map((item) => `${item.key}: ${item.description}`).join('\n')}</pre>}
                  <pre>{parsed.acceptanceCriteria.map((item) => `${item.id} · ${item.description}\nOracle: ${item.oracle}`).join('\n\n')}</pre>
                  <small>变更预算：{parsed.changeBudget.capabilities.join('、')}{parsed.changeBudget.paths.length ? ` · ${parsed.changeBudget.paths.join('、')}` : ''}</small>
                </details>;
              })}
            </>}
          </div>
        </section>

        <section className="task-section">
          <div className="section-head">
            <h2>运行信息</h2>
            <small>{runtimeInputs.length} 个请求</small>
          </div>
          <div className="question-list">
            {runtimeInputs.length === 0 ? <div className="card empty">当前没有 Agent 等待补充运行信息。</div> : runtimeInputs.map((input) => <article className="question card" key={input.request_id}>
              <div className="question-title">
                <AlertTriangle size={18}/>
                <div>
                  <p className="eyebrow">运行信息 · {deliveryUnitLabel(input.story_index)}</p>
                  <h3>{terminologyText(input.title)}</h3>
                  <small>来源：{agentLabel(input.source_agent)}</small>
                </div>
                <span className={`badge ${input.status === 'answered' || input.status === 'resolved' ? 'green' : 'amber'}`}>{input.status === 'resolved' ? '已用于恢复' : input.status === 'answered' ? '已回答' : input.status === 'superseded' ? '已失效' : '待回答'}</span>
              </div>
              <p>{terminologyText(input.question)}</p>
              {input.why && <p className="muted">为什么需要：{terminologyText(input.why)}</p>}
              {input.recommendation && <div className="recommendation">建议：{terminologyText(input.recommendation)}</div>}
              {input.answer ? <p className="answer"><b>你的答复：</b>{input.answer}</p> : input.status === 'pending' && <form action={answerRuntimeInputAction}>
                <input type="hidden" name="taskId" value={task.task_id}/>
                <input type="hidden" name="requestId" value={input.request_id}/>
                <textarea name="answer" required placeholder="填写继续当前执行所需的非敏感运行信息…"/>
                <button className="button" type="submit">保存答复</button>
              </form>}
            </article>)}
          </div>
          {waitingRuntimeLanes.map((lane) => {
            const agents = lane.lane === 'analysis' ? ['analyst-agent'] : ['dev-agent', 'test-agent'];
            const pending = runtimeInputs.filter((input) => input.status === 'pending' && agents.includes(input.source_agent));
            return pending.length === 0 && <form action={submitRuntimeInputsAction} className="release-block" key={lane.lane}>
              <input type="hidden" name="taskId" value={task.task_id}/>
              <input type="hidden" name="lane" value={lane.lane}/>
              <button className="button success">提交 {lane.lane === 'analysis' ? 'Analysis' : 'Delivery'} Lane 运行信息并交回 {agentLabel(lane.current_agent)}</button>
            </form>;
          })}
        </section>

        <section className="task-section">
          <div className="section-head">
            <h2>人工对齐</h2>
            <small>{questions.length} 个问题</small>
          </div>
          <div className="question-list">
            {questions.length === 0 ? <div className="card empty">当前没有待回答的对齐问题。</div> : questions.map((question) => <article className="question card" key={question.question_id}>
              <div className="question-title">
                <AlertTriangle size={18}/>
                <div>
                  <p className="eyebrow">{confirmationKindLabel(question.kind)} · {deliveryUnitLabel(question.story_index)}</p>
                  <h3>{terminologyText(question.title)}</h3>
                  {question.source_agent && <small>来源：{agentLabel(question.source_agent)}</small>}
                </div>
                <span className={`badge ${question.status === 'answered' || question.status === 'resolved' ? 'green' : 'amber'}`}>{question.status === 'resolved' ? '已纳入规格' : question.status === 'answered' ? '已回答' : '待回答'}</span>
              </div>
              <p>{terminologyText(question.question)}</p>
              {question.why && <p className="muted">为什么问：{terminologyText(question.why)}</p>}
              {question.recommendation && <div className="recommendation">推荐：{terminologyText(question.recommendation)}</div>}
              {question.recommendation_reason && <p className="muted">推荐理由：{terminologyText(question.recommendation_reason)}</p>}
              {question.alternatives_json && <pre>{(JSON.parse(question.alternatives_json) as { id: string; label: string; consequences: string[] }[]).map((option) => `${option.id} · ${option.label}${option.consequences.length ? `\n  ${option.consequences.join('\n  ')}` : ''}`).join('\n\n')}</pre>}
              {question.depends_on_json && <p className="muted">依赖决策：{(JSON.parse(question.depends_on_json) as string[]).join('、')}</p>}
              {question.answer ? <p className="answer"><b>你的答复：</b>{question.answer}</p> : <form action={answerQuestionAction}>
                <input type="hidden" name="taskId" value={task.task_id}/>
                <input type="hidden" name="questionId" value={question.question_id}/>
                <textarea name="answer" required placeholder="填写产品或重大技术决策、边界或补充信息…"/>
                <button className="button" type="submit">保存答复</button>
              </form>}
            </article>)}
          </div>
          {waitingForAnswers && unansweredQuestions.length === 0 && <form action={submitClarificationAnswersAction} className="release-block">
            <input type="hidden" name="taskId" value={task.task_id}/>
            <button className="button success">提交全部回答并交回 {agentLabel(waitingForControlAnswers ? task.current_subagent : 'analyst-agent')}</button>
          </form>}
        </section>

        {(task.agile_status === 'ready_to_close' || closureAcknowledgements.length > 0) && <section className="task-section">
          <div className="section-head"><h2>结卡报告</h2><small>版本 {task.review_revision}</small></div>
          <div className="card document-list">
            {reviewDocument ? <div className="document-item"><ArtifactDocument
              taskId={task.task_id}
              documentId={reviewDocument.document_id}
              content={reviewDocument.content}
              format={reviewDocument.format}
              revision={reviewDocument.revision}
              comments={documentComments.filter((comment) => comment.document_id === reviewDocument.document_id)}
              allowReopen={task.agile_status !== 'done'}
              allowComment={task.agile_status !== 'done'}
            /></div> : <div className="empty">结卡报告不可用，请重新运行 Review Agent。</div>}
          </div>
          {task.agile_status === 'ready_to_close' && reviewDocument && blockingFeedback.length > 0 && <div className="release-block">
            <p className="muted">当前有 {blockingFeedback.length} 条反馈等待 Feedback Agent 分流、处理和验证。它们会在下一次正常 Agent 派发前优先执行。</p>
          </div>}
          {task.agile_status === 'ready_to_close' && reviewDocument && blockingFeedback.length === 0 && <form action={acknowledgeClosureAction} className="release-block">
            <input type="hidden" name="taskId" value={task.task_id}/>
            <input type="hidden" name="reviewRevision" value={task.review_revision}/>
            <button className="button success">我已阅读结卡报告并关闭需求</button>
          </form>}
        </section>}

        <section className="task-section">
          <div className="section-head"><h2>活动记录</h2><small>{events.length} 条</small></div>
          <div className="card timeline">{events.length === 0 ? <div className="empty">暂无活动记录。</div> : events.map((event) => <div key={event.event_id}><span/><p><b>{agentLabel(event.actor)}</b> · {terminologyText(event.summary)}</p><small>{formatEventTime(event.created_at)}</small></div>)}</div>
        </section>
      </div>

      <aside className="task-action-column">
        <TaskContextChat taskId={task.task_id} initialSession={contextChat.session} initialMessages={contextChat.messages}/>

        <section className="card form-panel">
          <h2><GitBranch size={15}/>推进流程</h2>
          {pipeline.length === 0 ? <p className="muted">当前没有可派发步骤。</p> : pipeline.map((item) => <div className="pipeline-card" key={`${item.lane}-${item.pipeline}-${item.storyIndex || 0}`}>
            <GitBranch size={16}/>
            <div>
              <strong>{item.lane === 'analysis' ? 'Analysis' : item.lane === 'delivery' ? 'Delivery' : 'Control'} · {flowLabel(item.pipeline)} · {agentLabel(item.agent)}</strong>
              <small>{deliveryUnitLabel(item.storyIndex)} · {item.resource === 'browser' ? '浏览器' : '无需独占资源'}</small>
              <p>{item.description}</p>
            </div>
          </div>)}
        </section>

        {lanes.filter((lane) => lane.status === 'system_blocked').map((lane) => <form action={releaseBlockAction} className="card form-panel release-block" key={lane.lane}>
          <h2><AlertTriangle size={15}/>{lane.lane === 'analysis' ? 'Analysis' : 'Delivery'} Lane 阻塞</h2>
          <p className="muted">{terminologyText(lane.blocked_reason) || '本次 Lane 执行被系统暂停。'}</p>
          <input type="hidden" name="taskId" value={task.task_id}/>
          <input type="hidden" name="lane" value={lane.lane}/>
          <button className="button success" type="submit">解除该 Lane 阻塞并继续</button>
        </form>)}

        {task.agile_status === 'blocked' && task.run_state === 'system_blocked' && blockedLanes.length === 0 && <form action={releaseBlockAction} className="card form-panel release-block">
          <h2><AlertTriangle size={15}/>系统阻塞</h2>
          <p className="muted">{terminologyText(task.blocked_reason) || '本次执行被系统暂停。解除后将从已保存的执行结果继续。'}</p>
          <input type="hidden" name="taskId" value={task.task_id}/>
          <button className="button success" type="submit">解除系统阻塞并继续</button>
        </form>}

        {!['done', 'cancelled'].includes(task.agile_status) && <details className="card danger-card task-danger-zone">
          <summary>危险操作</summary>
          <form action={cancelTaskAction} className="form-panel">
            <h2>取消需求</h2>
            <p className="muted">仅用于业务目标已经撤回、重复或无效；正常反馈请使用文档评论或澄清回答。</p>
            <input type="hidden" name="taskId" value={task.task_id}/>
            <label>原因<input name="reason" required placeholder="重复、撤回或无效"/></label>
            <button className="button danger" type="submit">取消需求</button>
          </form>
        </details>}
      </aside>
    </div>

    <section className="task-section task-audit-section">
      <div className="section-head">
        <h2>执行审计</h2>
        <small>{executionAttempts.length} 次执行尝试 · 技术追溯信息</small>
      </div>
      <details className="card audit-details">
        <summary className="audit-summary">
          <GitBranch size={16}/>
          <span>查看 Agent 输入版本、提交与验证关联</span>
          <small>默认折叠</small>
        </summary>
        <div className="document-list">
          {executionAttempts.length === 0 ? <div className="empty">尚无执行审计记录。</div> : executionAttempts.map((attempt) => <details key={attempt.execution_id} className="document-item">
            <summary><GitBranch size={15}/><span>{attempt.lane ? `${attempt.lane === 'analysis' ? 'Analysis' : attempt.lane === 'delivery' ? 'Delivery' : 'Control'} · ` : ''}{deliveryUnitLabel(attempt.story_index)} · {agentLabel(attempt.agent)} · attempt {attempt.attempt}</span><small>{attempt.status}</small></summary>
            <pre>{[
              `execution: ${attempt.execution_id}`,
              `input hash: ${attempt.input_hash}`,
              attempt.base_commit ? `base commit: ${attempt.base_commit}` : '',
              attempt.code_commit ? `code commit: ${attempt.code_commit}` : '',
              attempt.verification_id ? `verification: ${attempt.verification_id}` : '',
              attempt.prompt_version ? `prompt: v${attempt.prompt_version} · ${attempt.prompt_hash || ''}` : '',
              attempt.memory_revision ? `memory: r${attempt.memory_revision} · ${attempt.memory_hash || ''}` : '',
              attempt.last_error ? `error: ${attempt.last_error}` : '',
            ].filter(Boolean).join('\n')}</pre>
          </details>)}
        </div>
      </details>
    </section>
  </>;
}
