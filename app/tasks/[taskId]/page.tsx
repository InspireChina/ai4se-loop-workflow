import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Clock3, FileText, GitBranch, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { getTask, pipelineForTask } from '../../../src/application/tasks';
import {
  addQuestionAction,
  addStoryAction,
  answerQuestionAction,
  cancelTaskAction,
  initializeContextAction,
  releaseBlockAction,
  rewindTaskAction,
  transitionTaskAction,
} from '../../actions';

export const dynamic = 'force-dynamic';

const statusOptions = ['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'done', 'blocked'];
const agentOptions = ['backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent', 'dev-agent', 'test-agent', 'review-agent'];

export default async function TaskDetail({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const detail = await getTask(taskId);
  if (!detail) notFound();
  const { task, stories, questions, documents, approvals, events } = detail;
  const pipeline = await pipelineForTask(taskId);
  const unansweredQuestions = questions.filter((question) => question.status !== 'answered');

  return <>
    <header className="task-header">
      <Link className="crumb" href="/tasks">Task</Link>
      <div className="task-title-row">
        <div>
          <p className="eyebrow">{task.task_id}</p>
          <h1>{task.title}</h1>
        </div>
        <span className={`badge ${task.agile_status === 'blocked' ? 'amber' : task.agile_status === 'done' ? 'green' : 'blue'}`}>{task.agile_status}</span>
      </div>
      <div className="chips">
        <span>{task.item_type}</span>
        <span>{task.priority || '未定级'}</span>
        <span>{task.current_subagent || '未分配'}</span>
        {task.link && <a href={task.link} target="_blank" rel="noreferrer">{task.link}</a>}
      </div>
    </header>

    <section className="card task-summary">
      <div><small>分析</small><b>{task.analysis_index} / {task.total_stories}</b></div>
      <div><small>开发</small><b>{task.dev_index} / {task.total_stories}</b></div>
      <div><small>测试</small><b>{task.test_index} / {task.total_stories}</b></div>
      <div><small>待确认</small><b>{unansweredQuestions.length}</b></div>
      <div className="summary-wide"><small>下一步</small><p>{task.next_step || '—'}</p></div>
      <div className="summary-wide"><small>文档</small><p>{documents.length} 个数据库文档</p></div>
    </section>

    <div className="task-detail-grid">
      <div className="task-main-column">
        <section className="task-section">
          <div className="section-head">
            <h2>Story</h2>
            <small>{stories.length ? `${stories.length} 个 Story` : '尚未拆分'}</small>
          </div>
          <div className="card story-list">
            {stories.length === 0 ? <div className="empty">尚未拆分 Story。</div> : stories.map((story) => <div className="story" key={story.story_index}>
              <span className={story.story_index <= task.test_index ? 'done' : story.story_index <= task.dev_index ? 'active' : ''}>
                {story.story_index <= task.test_index ? <CheckCircle2 size={16}/> : <Clock3 size={16}/>}
              </span>
              <div>
                <strong>Story-{story.story_index} · {story.title}</strong>
                <small>{story.directory || 'DB'}</small>
              </div>
              <em>{story.story_index <= task.test_index ? '测试完成' : story.story_index <= task.dev_index ? '等待测试' : story.story_index <= task.analysis_index ? '等待开发' : '等待分析'}</em>
            </div>)}
          </div>
          <form action={addStoryAction} className="card form-panel inline-create">
            <input type="hidden" name="taskId" value={task.task_id}/>
            <label>新增 Story<input name="title" required placeholder="Story 标题"/></label>
            <button className="button secondary" type="submit">添加</button>
          </form>
        </section>

        <section className="task-section">
          <div className="section-head">
            <h2>Questions 与 Approval</h2>
            <small>{questions.length} 个问题 · {approvals.length} 个 Approval</small>
          </div>
          <form action={addQuestionAction} className="card form-panel question-create">
            <input type="hidden" name="taskId" value={task.task_id}/>
            <div className="fields">
              <label>类型<select name="kind" defaultValue="analysis"><option value="local">local</option><option value="analysis">analysis</option><option value="test">test</option><option value="review">review</option></select></label>
              <label>Story<input name="storyIndex" type="number" min="1" max={Math.max(task.total_stories, 1)} placeholder="可选"/></label>
            </div>
            <label>标题<input name="title" required placeholder="需要确认的问题标题"/></label>
            <label>问题<textarea name="question" required placeholder="填写需要人工确认的具体问题"/></label>
            <div className="fields">
              <label>为什么问<input name="why"/></label>
              <label>推荐答案<input name="recommendation"/></label>
            </div>
            <label>阻塞原因<input name="blockedReason" placeholder="默认使用问题标题"/></label>
            <label className="checkbox"><input type="checkbox" name="blockTask" defaultChecked/>创建后进入 blocked</label>
            <button className="button" type="submit">新增问题</button>
          </form>
          <div className="question-list">
            {questions.length === 0 ? <div className="card empty">当前没有待确认问题。</div> : questions.map((question, index) => <article className="question card" key={question.question_id}>
              <div className="question-title">
                <AlertTriangle size={18}/>
                <div>
                  <p className="eyebrow">{question.kind.toUpperCase()} · {question.story_index ? `STORY-${question.story_index}` : 'TASK'}</p>
                  <h3>{question.title}</h3>
                  {question.source_agent && <small>来源：{question.source_agent}</small>}
                </div>
                <span className={`badge ${question.status === 'answered' ? 'green' : 'amber'}`}>{question.status === 'answered' ? '已回答' : '待确认'}</span>
              </div>
              <p>{question.question}</p>
              {question.why && <p className="muted">为什么问：{question.why}</p>}
              {question.recommendation && <div className="recommendation">推荐：{question.recommendation}</div>}
              {question.answer ? <p className="answer"><b>你的答复：</b>{question.answer}</p> : <form action={answerQuestionAction}>
                <input type="hidden" name="taskId" value={task.task_id}/>
                <input type="hidden" name="questionId" value={question.question_id}/>
                <textarea name="answer" required placeholder="填写确认结论、边界或补充信息…"/>
                <button className="button" type="submit">保存答复</button>
              </form>}
            </article>)}
          </div>
          {task.agile_status === 'blocked' && questions.every((question) => question.status === 'answered') && <form action={releaseBlockAction} className="release-block">
            <input type="hidden" name="taskId" value={task.task_id}/>
            <button className="button success">解除阻塞并交回 {task.current_subagent}</button>
          </form>}
        </section>

        <section className="task-section two-card-grid">
          <div>
            <div className="section-head"><h2>Documents</h2><small>{documents.length} 个文档</small></div>
            <div className="card document-list">{documents.length === 0 ? <div className="empty">还没有数据库文档。</div> : documents.map((document) => <details key={document.document_id} className="document-item">
              <summary><FileText size={15}/><span>{document.title}</span><small>{[document.kind, document.story_index ? `Story-${document.story_index}` : 'Task', document.source_agent || ''].filter(Boolean).join(' · ')}</small></summary>
              <pre>{document.content}</pre>
            </details>)}</div>
          </div>
          <div>
            <div className="section-head"><h2>Approvals</h2><small>{approvals.length} 条记录</small></div>
            <div className="card artifact-list">{approvals.length === 0 ? <div className="empty">还没有 Approval。</div> : approvals.map((approval) => <div key={approval.approval_id}><CheckCircle2 size={15}/><span>{approval.kind} · {approval.decision}</span><small>{approval.story_index ? `Story-${approval.story_index}` : 'Task'}</small></div>)}</div>
          </div>
        </section>

        <section className="task-section">
          <div className="section-head"><h2>活动记录</h2><small>{events.length} 条</small></div>
          <div className="card timeline">{events.length === 0 ? <div className="empty">暂无活动记录。</div> : events.map((event) => <div key={event.event_id}><span/><p><b>{event.actor}</b> · {event.summary}</p><small>{event.created_at}</small></div>)}</div>
        </section>
      </div>

      <aside className="task-action-column">
        <section className="card form-panel">
          <h2><GitBranch size={15}/>Pipeline</h2>
          {pipeline.length === 0 ? <p className="muted">当前没有可派发步骤。</p> : pipeline.map((item) => <div className="pipeline-card" key={`${item.pipeline}-${item.storyIndex || 0}`}>
            <GitBranch size={16}/>
            <div>
              <strong>{item.pipeline} · {item.agent}</strong>
              <small>{item.storyIndex ? `Story-${item.storyIndex}` : 'Task 级'} · {item.resource}</small>
              <p>{item.description}</p>
            </div>
          </div>)}
        </section>

        <form action={initializeContextAction} className="card form-panel">
          <h2>数据库上下文</h2>
          <input type="hidden" name="taskId" value={task.task_id}/>
          <div className="fields">
            <label>类型<select name="kind" defaultValue={task.item_type}><option value="feature">feature</option><option value="bug">bug</option><option value="tech">tech</option><option value="intake">intake</option></select></label>
            <label>说明<input name="slug" placeholder="可选备注，不创建目录"/></label>
          </div>
          <div className="fields">
            <label>状态<select name="status" defaultValue={task.agile_status === 'backlog' ? 'in plan' : task.agile_status}>{statusOptions.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
            <label>Agent<select name="currentSubagent" defaultValue={task.current_subagent || 'story-splitter-agent'}>{agentOptions.map((agent) => <option value={agent} key={agent}>{agent}</option>)}</select></label>
          </div>
          <label>下一步<input name="nextStep" placeholder="例如：拆分 story"/></label>
          <button className="button" type="submit">初始化 / 同步上下文</button>
        </form>

        <form action={transitionTaskAction} className="card form-panel">
          <h2><SlidersHorizontal size={15}/>状态流转</h2>
          <input type="hidden" name="taskId" value={task.task_id}/>
          <div className="fields">
            <label>状态<select name="status" defaultValue={task.agile_status}>{statusOptions.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
            <label>Agent<select name="currentSubagent" defaultValue={task.current_subagent || ''}><option value="">不修改</option>{agentOptions.map((agent) => <option value={agent} key={agent}>{agent}</option>)}</select></label>
          </div>
          <label>下一步<input name="nextStep" placeholder="更新 next_step"/></label>
          <button className="button secondary" type="submit">更新状态</button>
        </form>

        <form action={rewindTaskAction} className="card form-panel">
          <h2><RotateCcw size={15}/>Rewind</h2>
          <input type="hidden" name="taskId" value={task.task_id}/>
          <div className="fields">
            <label>回退到<select name="to" defaultValue="analysis"><option value="plan">plan</option><option value="analysis">analysis</option><option value="dev">dev</option><option value="test">test</option></select></label>
            <label>Story<input name="story" type="number" min="1" max={Math.max(task.total_stories, 1)} placeholder="需要 story"/></label>
          </div>
          <label>原因<input name="reason" placeholder="为什么需要回退"/></label>
          <button className="button secondary" type="submit">执行 Rewind</button>
        </form>

        <form action={cancelTaskAction} className="card form-panel danger-card">
          <h2>取消 Task</h2>
          <input type="hidden" name="taskId" value={task.task_id}/>
          <label>原因<input name="reason" required placeholder="重复、撤回或无效"/></label>
          <label className="checkbox"><input type="checkbox" name="confirmCodeClean"/>代码槽已清理</label>
          <button className="button danger" type="submit">取消 Task</button>
        </form>
      </aside>
    </div>
  </>;
}
