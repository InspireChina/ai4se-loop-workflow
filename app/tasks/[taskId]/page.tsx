import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Clock3, FileText, GitBranch } from 'lucide-react';
import { formatEventTime } from '../../../src/application/event-time';
import { getTask, pipelineForTask } from '../../../src/application/tasks';
import { getTaskContextChat } from '../../../src/application/task-context-chat';
import { deliverySpecSchema } from '../../../src/domain/agent-result';
import { agentLabel, deliveryUnitLabel, documentKindLabel, feedbackBatchStatusLabel, feedbackWorkTypeLabel, flowLabel, itemTypeLabel, statusLabel, terminologyText } from '../../../src/domain/terminology';
import { ArtifactDocument } from './artifact-document';
import { TaskAutoRefresh } from './task-auto-refresh';
import { TaskContextChat } from './task-context-chat';
import {
  acknowledgeClosureAction,
  addStoryAction,
  answerRuntimeInputAction,
  cancelTaskAction,
  releaseBlockAction,
  submitRuntimeInputsAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

function parseDeliverySpec(content: string) {
  try {
    const parsed = deliverySpecSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const standardTaskSteps = [
  { label: '需求整理', statuses: ['backlog'] },
  { label: '交付拆分', statuses: ['in plan'] },
  { label: '单元推进', statuses: ['ready for dev', 'in dev', 'in feedback'] },
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
    const laneName = lane.lane === 'analysis' ? '交付分析' : '开发验证';
    const state = lane.status === 'waiting_for_answers'
      ? '等待澄清'
      : lane.status === 'waiting_for_runtime_input'
        ? lane.current_agent === 'test-agent' ? '等待验证协助' : '等待运行信息'
        : '系统阻塞';
    return `${laneName} ${state} · ${agentLabel(lane.current_agent)}`;
  }).join('；');
  if (task.run_state === 'waiting_for_answers') return `等待需求级澄清 · ${agentLabel(task.current_subagent)}`;
  if (task.run_state === 'waiting_for_runtime_input') return `等待补充运行信息 · ${agentLabel(task.current_subagent)}`;
  if (task.agile_status === 'blocked') return `系统异常已暂停 · ${agentLabel(task.current_subagent)}`;
  if (task.agile_status === 'backlog') return '正在收集上下文';
  if (task.agile_status === 'in repro') return '正在复现并定位问题';
  if (task.agile_status === 'in plan') return '正在拆分交付单元';
  if (task.agile_status === 'ready for dev') return '准备逐个推进交付单元';
  if (task.agile_status === 'in dev') return `交付分析 ${task.analysis_index}/${task.total_stories} · 实现 ${task.dev_index}/${task.total_stories} · 验证 ${task.test_index}/${task.total_stories}`;
  if (task.agile_status === 'in feedback') return `向前处理反馈 · 交付分析 ${task.analysis_index}/${task.total_stories} · 实现 ${task.dev_index}/${task.total_stories} · 验证 ${task.test_index}/${task.total_stories}`;
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

function laneStatusText(lane: { status: string; current_agent: string | null }) {
  if (lane.status === 'waiting_for_runtime_input' && lane.current_agent === 'test-agent') {
    return '等待验证协助';
  }
  return laneStatusLabel(lane.status);
}

function feedbackGroupStatusLabel(group: { status: string; work_type: string; delivery_unit_indexes?: number[] }) {
  if (group.status === 'executing') {
    if (group.work_type === 'report_correction') return '等待新版结卡报告';
    if (group.delivery_unit_indexes?.length) return '追加单元推进中';
    return '前向处理中';
  }
  return ({
    planned: '已规划',
    waiting_for_repro: '等待复现',
    waiting_for_plan: '等待拆分',
    ready_for_verification: '等待独立验证',
    completed: '已完成',
    reopened: '验证未通过，已进入新批次',
    cancelled: '已取消',
    system_blocked: '系统阻塞',
  } as Record<string, string>)[group.status] || group.status;
}

export default async function TaskDetail({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const detail = await getTask(taskId);
  if (!detail) notFound();
  const { task, lanes, stories, deliverySpecs, questions, runtimeInputs, documents, documentComments, feedbackBatches, feedbackGroups, closureAcknowledgements, executionAttempts, events } = detail;
  const analysisLane = lanes.find((lane) => lane.lane === 'analysis')!;
  const deliveryLane = lanes.find((lane) => lane.lane === 'delivery')!;
  const pipeline = await pipelineForTask(taskId);
  const contextChat = await getTaskContextChat(taskId);
  const unansweredQuestions = questions.filter((question) => question.status === 'pending');
  const agentHandledDecisions = questions.filter((question) => question.decision_authority === 'agent' && ['answered', 'resolved'].includes(question.status));
  const userDecisions = questions.filter((question) => question.decision_authority === 'human' && ['answered', 'resolved'].includes(question.status));
  const waitingForControlAnswers = task.run_state === 'waiting_for_answers'
    && (task.current_subagent === 'backlog-agent' || task.current_subagent === 'repro-agent' || task.current_subagent === 'feedback-agent');
  const waitingForAnswers = waitingForControlAnswers || analysisLane.status === 'waiting_for_answers';
  const nextStepText = waitingForAnswers && unansweredQuestions.length === 0
    ? `回答已保存，提交后交回 ${agentLabel(waitingForControlAnswers ? task.current_subagent : 'analyst-agent')}`
    : terminologyText(task.next_step) || '—';
  const currentStepDetail = waitingForAnswers && unansweredQuestions.length === 0
    ? `回答已保存，等待提交 · ${agentLabel(waitingForControlAnswers ? task.current_subagent : 'analyst-agent')}`
    : stepDetail(task, lanes);
  const unansweredRuntimeInputs = runtimeInputs.filter((input) => input.status === 'pending');
  const waitingRuntimeLanes = lanes.filter((lane) => lane.status === 'waiting_for_runtime_input');
  const waitingForRuntimeInput = waitingRuntimeLanes.length > 0;
  const waitingForVerificationAssistance = waitingRuntimeLanes.some((lane) =>
    lane.current_agent === 'test-agent');
  const blockedLanes = lanes.filter((lane) => lane.status === 'system_blocked');
  const reviewDocument = task.review_document_id ? documents.find((document) => document.document_id === task.review_document_id) : null;
  const blockingFeedback = documentComments.filter((comment) => comment.feedback_status !== 'resolved');
  const deliveryDocuments = documents.filter((document) => document.document_id !== reviewDocument?.document_id);
  const progressStatus = task.agile_status === 'blocked' ? task.resume_status || 'backlog' : task.agile_status;
  const taskSteps = task.item_type === 'bug' || progressStatus === 'in repro' ? bugTaskSteps : standardTaskSteps;
  const currentStep = taskSteps.findIndex((step) => step.statuses.some((status) => status === progressStatus));
  const currentSpecs = deliverySpecs.filter((spec) => spec.status !== 'superseded');

  return <>
    <header className="task-header">
      <Link className="crumb" href="/tasks">需求</Link>
      <div className="task-title-row">
        <div>
          <p className="eyebrow">{task.task_id}</p>
          <h1>{task.title}</h1>
        </div>
        <span className={`badge ${task.agile_status === 'blocked' || waitingForAnswers || waitingForRuntimeInput || blockedLanes.length ? 'amber' : task.agile_status === 'done' ? 'green' : 'blue'}`}>{waitingForVerificationAssistance ? '等待验证协助' : waitingForRuntimeInput ? '等待运行信息' : waitingForAnswers ? '等待关键决策' : blockedLanes.length ? '通道阻塞' : statusLabel(task.agile_status)}</span>
      </div>
      <div className="chips">
        <TaskAutoRefresh/>
        <span>{itemTypeLabel(task.item_type)}</span>
        <span>{task.priority || '未定级'}</span>
        <span>交付分析 · {agentLabel(analysisLane.current_agent)}</span>
        <span>开发验证 · {agentLabel(deliveryLane.current_agent)}</span>
        {task.link && <a href={task.link} target="_blank" rel="noreferrer">{task.link}</a>}
      </div>
    </header>

    <section className="card task-original-input" aria-labelledby="task-original-input-title">
      <div className="task-original-input-head">
        <div>
          <p className="eyebrow">创建时输入</p>
          <h2 id="task-original-input-title"><FileText size={17}/>原始需求</h2>
        </div>
        <small>后续工作流不会改写此内容</small>
      </div>
      {task.description
        ? <p className="task-original-input-content">{task.description}</p>
        : <p className="task-original-input-empty">创建时未填写补充描述，原始需求仅包含标题。</p>}
    </section>

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
          <strong>{currentStepDetail}</strong>
        </div>
      </div>
    </section>

    <section className="card task-summary">
      <div><small>交付分析</small><b>{task.analysis_index} / {task.total_stories}</b></div>
      <div><small>实现</small><b>{task.dev_index} / {task.total_stories}</b></div>
      <div><small>验证</small><b>{task.test_index} / {task.total_stories}</b></div>
      <div><small>待回答决策</small><b>{unansweredQuestions.length}</b></div>
      <div><small>待补充信息或验证协助</small><b>{unansweredRuntimeInputs.length}</b></div>
      <div className="summary-wide"><small>下一步</small><p>{nextStepText}</p></div>
      <div className="summary-wide"><small>文档</small><p>{documents.length} 个数据库文档</p></div>
    </section>

    <section className="lane-grid" aria-label="任务并行 Lane 状态">
      {[analysisLane, deliveryLane].map((lane) => <article className={`card lane-card ${lane.status}`} key={lane.lane}>
        <div className="lane-card-head">
          <div>
            <p className="eyebrow">{lane.lane === 'analysis' ? '交付分析通道' : '开发验证通道'}</p>
            <h2>{lane.lane === 'analysis' ? '交付分析流水线' : '开发验证流水线'}</h2>
          </div>
          <span className={`badge ${lane.status === 'completed' ? 'green' : lane.status.includes('waiting') || lane.status === 'system_blocked' ? 'amber' : 'blue'}`}>{laneStatusText(lane)}</span>
        </div>
        <div className="lane-progress">
          {lane.lane === 'analysis'
            ? `交付分析 ${task.analysis_index}/${task.total_stories}`
            : `实现 ${task.dev_index}/${task.total_stories} · 验证 ${task.test_index}/${task.total_stories}`}
        </div>
        <p>{lane.current_agent ? `${agentLabel(lane.current_agent)}${lane.current_story_index ? ` · ${deliveryUnitLabel(lane.current_story_index)}` : ''}` : lane.status === 'pending' ? '等待可消费的上游结果' : '当前没有运行中的 Agent'}</p>
        {lane.blocked_reason && <small>{terminologyText(lane.blocked_reason)}</small>}
      </article>)}
    </section>

    <section className="task-decision-entry-section" id="decision-alignment">
      <div className="section-head">
        <h2>决策对齐</h2>
        <small>任务级决策入口</small>
      </div>
      <div className="decision-alignment-entry card">
        <span className="decision-alignment-entry-icon"><GitBranch size={18}/></span>
        <div>
          <p className="eyebrow">DECISION ALIGNMENT · LIVE</p>
          <strong>查看任务级决策清单</strong>
          <small>集中查看并处理需要你决定、Agent 已关闭和历史失效的决策节点。</small>
          <div className="decision-alignment-entry-counts">
            <span className="amber">需要我决策 {unansweredQuestions.length}</span>
            <span>Agent 已处理 {agentHandledDecisions.length}</span>
            <span className="green">用户已决定 {userDecisions.length}</span>
          </div>
        </div>
        <Link href={`/decisions?taskId=${encodeURIComponent(task.task_id)}`} className="button secondary">打开决策对齐 <ArrowRight size={14}/></Link>
      </div>
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
                <small>{story.origin_type === 'original'
                  ? story.directory || 'DB'
                  : `反馈追加 · ${story.origin_type === 'feedback_bug' ? 'Bug 修复' : story.origin_type === 'feedback_scope' ? '范围新增' : story.origin_type === 'feedback_technical' ? '技术调整' : '行为修订'}`}</small>
              </div>
              <em>{story.story_index <= task.test_index ? '验证完成' : story.story_index <= task.dev_index ? '等待验证' : story.story_index <= task.analysis_index ? '等待开发' : '等待交付分析'}</em>
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
                feedbackGroups={feedbackGroups}
                allowReopen={task.agile_status !== 'done'}
                allowComment={task.agile_status !== 'done'}
              />
            </details>)}</div>
          </div>
        </section>

        {feedbackBatches.length > 0 && <section className="task-section">
          <div className="section-head">
            <h2>反馈批次</h2>
            <small>{feedbackBatches.length} 个批次 · {feedbackBatches.filter((batch) => !['completed', 'cancelled'].includes(batch.status)).length} 个活动批次</small>
          </div>
          <div className="feedback-batch-list">
            {feedbackBatches.map((batch) => {
              const groups = feedbackGroups.filter((group) => group.batch_id === batch.batch_id);
              return <article className="card feedback-batch" key={batch.batch_id}>
                <header className="feedback-batch-head">
                  <div>
                    <strong>反馈批次 {batch.batch_number}</strong>
                    {batch.summary && <small>{batch.summary}</small>}
                  </div>
                  <span className={`badge ${batch.status === 'completed' ? 'green' : batch.status === 'system_blocked' ? 'amber' : 'blue'}`}>{feedbackBatchStatusLabel(batch.status)}</span>
                </header>
                <div className="story-list">
                  {groups.length === 0 ? <div className="empty">评论已经冻结，等待反馈处理 Agent 分组。</div> : groups.map((group) => <div className="story" key={group.group_id}>
                    <span className={group.status === 'completed' ? 'done' : group.status === 'reopened' || group.status === 'cancelled' ? '' : 'active'}>
                      {group.status === 'completed' ? <CheckCircle2 size={16}/> : <Clock3 size={16}/>}
                    </span>
                    <div>
                      <strong>{group.title || group.reason}</strong>
                      <small>{feedbackWorkTypeLabel(group.work_type)}
                        {group.delivery_unit_indexes?.length ? ` · 新增交付单元 ${group.delivery_unit_indexes.join('、')}` : ''}
                      </small>
                    </div>
                    <em>{feedbackGroupStatusLabel(group)}</em>
                  </div>)}
                </div>
              </article>;
            })}
          </div>
        </section>}

        <section className="task-section">
          <div className="section-head">
            <h2>交付规格</h2>
            <small>{currentSpecs.length} 个当前规格</small>
          </div>
          <div className="card document-list">
            {currentSpecs.length === 0 ? <div className="empty">交付分析完成后会在这里显示版本化影响、决策与冻结交付契约，验证证据由验证 Agent 独立写入交付文档。</div> : <>
              {currentSpecs.map((spec) => {
                const parsed = parseDeliverySpec(spec.spec_json);
                if (!parsed) {
                  return <details key={spec.spec_id} className="document-item">
                    <summary><AlertTriangle size={15}/><span>{deliveryUnitLabel(spec.story_index)} · 无法识别的规格记录 v{spec.revision}</span><small>不可用于推进</small></summary>
                    <div className="empty">这条记录不符合当前交付规格协议。页面已隔离该记录；新的交付分析会生成可验证的正式规格。</div>
                  </details>;
                }
                return <details key={spec.spec_id} className="document-item" open={spec.status === 'waiting_for_answers'}>
                  <summary><FileText size={15}/><span>{deliveryUnitLabel(spec.story_index)} · 交付分析 v{spec.revision}</span><small>{spec.status === 'resolved' ? '已收敛' : '等待关键决策'}</small></summary>
                  <div className="answer"><b>{parsed.unit.title}</b><br/>{parsed.unit.actor} 在 {parsed.unit.trigger} 时，{parsed.unit.observableOutcome}<br/><small>验收语义：{parsed.unit.acceptance}</small></div>
                  <div className="answer"><b>分析结论：</b>{parsed.summary}</div>
                  <pre>{parsed.impacts.map((item) =>
                    `${item.disposition} · ${item.area}\n${item.finding}\n证据：${item.evidence}`).join('\n\n')}</pre>
                  {!!parsed.decisions.length && <pre>{parsed.decisions.map((item) => [
                    `${item.type === 'business' ? '业务决策' : '技术决策'} · ${item.title}`,
                    item.status === 'resolved'
                      ? `已确定：${item.decision} · 权限 ${item.authority}${item.evidence ? `\n证据：${item.evidence}` : ''}`
                      : `等待用户决策：${item.question}`,
                  ].join('\n')).join('\n\n')}</pre>}
                  <div className="answer"><b>交付契约 · 实现方向：</b>{parsed.handoff.implementationGuidance}</div>
                  {!!parsed.handoff.guardrails.length && <small>保护约束：{parsed.handoff.guardrails.map((item) => item.content).join('；')}</small>}
                  <pre>{[
                    `${parsed.unit.acceptance}\nOracle: ${parsed.unit.observableOutcome}`,
                    ...parsed.handoff.verificationFocus.map((item) =>
                      `${item.expected}\nOracle: ${item.oracle}`),
                  ].join('\n\n')}</pre>
                </details>;
              })}
            </>}
          </div>
        </section>

        <section className="task-section">
          <div className="section-head">
            <h2>运行信息与验证协助</h2>
            <small>{runtimeInputs.length} 个请求</small>
          </div>
          <div className="question-list">
            {runtimeInputs.length === 0 ? <div className="card empty">当前没有 Agent 等待补充信息或验证协助。</div> : runtimeInputs.map((input) => {
              const verificationAssistance = input.source_agent === 'test-agent';
              return <article className="question card" key={input.request_id}>
              <div className="question-title">
                <AlertTriangle size={18}/>
                <div>
                  <p className="eyebrow">{verificationAssistance ? '验证协助' : '运行信息'} · {deliveryUnitLabel(input.story_index)}</p>
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
                <textarea name="answer" required placeholder={verificationAssistance ? '补充依赖或环境；也可以填写你的手测结果、实际观察和证据…' : '填写继续当前执行所需的非敏感运行信息…'}/>
                <button className="button" type="submit">{verificationAssistance ? '保存验证协助' : '保存答复'}</button>
              </form>}
            </article>;
            })}
          </div>
          {waitingRuntimeLanes.map((lane) => {
            const agents = lane.lane === 'analysis' ? ['analyst-agent'] : ['dev-agent', 'test-agent'];
            const pending = runtimeInputs.filter((input) => input.status === 'pending' && agents.includes(input.source_agent));
            return pending.length === 0 && <form action={submitRuntimeInputsAction} className="release-block" key={lane.lane}>
              <input type="hidden" name="taskId" value={task.task_id}/>
              <input type="hidden" name="lane" value={lane.lane}/>
              <button className="button success">提交{lane.current_agent === 'test-agent' ? '验证协助' : `${lane.lane === 'analysis' ? '交付分析' : '开发验证'}运行信息`}并交回 {agentLabel(lane.current_agent)}</button>
            </form>;
          })}
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
              feedbackGroups={feedbackGroups}
              allowReopen={task.agile_status !== 'done'}
              allowComment={task.agile_status !== 'done'}
            /></div> : <div className="empty">结卡报告不可用，请重新运行 Review Agent。</div>}
          </div>
          {task.agile_status === 'ready_to_close' && reviewDocument && blockingFeedback.length > 0 && <div className="release-block">
            <p className="muted">当前有 {blockingFeedback.length} 条反馈尚未闭环。系统会冻结为一个批次；需要修改的反馈将追加新的交付单元，不会回退或改写既有交付。</p>
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
              <strong>{item.lane === 'analysis' ? '交付分析' : item.lane === 'delivery' ? '开发验证' : '控制'} · {flowLabel(item.pipeline)} · {agentLabel(item.agent)}</strong>
              <small>{deliveryUnitLabel(item.storyIndex)} · {item.resource === 'browser' ? '浏览器' : '无需独占资源'}</small>
              <p>{item.description}</p>
            </div>
          </div>)}
        </section>

        {lanes.filter((lane) => lane.status === 'system_blocked').map((lane) => <form action={releaseBlockAction} className="card form-panel release-block" key={lane.lane}>
          <h2><AlertTriangle size={15}/>{lane.lane === 'analysis' ? '交付分析' : '开发验证'}通道阻塞</h2>
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
            <summary><GitBranch size={15}/><span>{attempt.lane ? `${attempt.lane === 'analysis' ? '交付分析' : attempt.lane === 'delivery' ? '开发验证' : '控制'} · ` : ''}{deliveryUnitLabel(attempt.story_index)} · {agentLabel(attempt.agent)} · attempt {attempt.attempt}</span><small>{attempt.status}</small></summary>
            <pre>{[
              `execution: ${attempt.execution_id}`,
              `input hash: ${attempt.input_hash}`,
              attempt.base_commit ? `base commit: ${attempt.base_commit}` : '',
              attempt.code_commit ? `code commit: ${attempt.code_commit}` : '',
              attempt.verification_id ? `verification: ${attempt.verification_id}` : '',
              attempt.prompt_version ? `prompt: Project r${attempt.prompt_version} · template v${attempt.prompt_template_version || 1} · ${attempt.prompt_hash || ''}` : '',
              attempt.memory_revision ? `memory: r${attempt.memory_revision} · ${attempt.memory_hash || ''}` : '',
              attempt.last_error ? `error: ${attempt.last_error}` : '',
            ].filter(Boolean).join('\n')}</pre>
          </details>)}
        </div>
      </details>
    </section>
  </>;
}
