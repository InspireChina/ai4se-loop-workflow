import { notFound } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Clock3, FileText, AlertTriangle } from 'lucide-react';
import { getTask, readQuestionArtifact } from '../../../src/application/tasks';
import { answerQuestionAction, releaseBlockAction } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function TaskDetail({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params; const detail = await getTask(taskId); if (!detail) notFound();
  const { task, stories, questions, events } = detail;
  const artifactBodies = await Promise.all(questions.map((question) => readQuestionArtifact(question.relative_path)));
  return <><header><Link className="crumb" href="/tasks">Task</Link><p className="eyebrow">{task.task_id}</p><h1>{task.title}</h1><div className="chips"><span className="badge blue">{task.agile_status}</span><span>{task.item_type}</span><span>{task.priority}</span><span>{task.current_subagent}</span></div></header>
    <section className="card overview"><div><small>分析</small><b>{task.analysis_index} / {task.total_stories}</b></div><div><small>开发</small><b>{task.dev_index} / {task.total_stories}</b></div><div><small>测试</small><b>{task.test_index} / {task.total_stories}</b></div><div><small>下一步</small><p>{task.next_step}</p></div></section>
    <section><h2>Story</h2><div className="card story-list">{stories.map((story) => <div className="story" key={story.story_index}><span className={story.story_index <= task.test_index ? 'done' : story.story_index <= task.dev_index ? 'active' : ''}>{story.story_index <= task.test_index ? <CheckCircle2 size={16}/> : <Clock3 size={16}/>}</span><div><strong>Story-{story.story_index} · {story.title}</strong><small>{story.directory}</small></div><em>{story.story_index <= task.test_index ? '测试完成' : story.story_index <= task.dev_index ? '等待测试' : story.story_index <= task.analysis_index ? '等待开发' : '等待分析'}</em></div>)}</div></section>
    <section><h2>Questions 与 Approval</h2>{questions.map((question, index) => <article className="question card" key={question.question_id}><div className="question-title"><AlertTriangle size={18}/><div><p className="eyebrow">{question.kind.toUpperCase()} · STORY-{question.story_index}</p><h3>{question.title}</h3></div><span className={`badge ${question.status === 'answered' ? 'green' : 'amber'}`}>{question.status === 'answered' ? '已回答' : '待确认'}</span></div><p>{question.question}</p>{question.recommendation && <div className="recommendation">推荐：{question.recommendation}</div>}{question.answer ? <p className="answer"><b>你的答复：</b>{question.answer}</p> : <form action={answerQuestionAction}><input type="hidden" name="taskId" value={task.task_id}/><input type="hidden" name="questionId" value={question.question_id}/><textarea name="answer" required placeholder="填写确认结论、边界或补充信息…"/><button className="button" type="submit">保存答复</button></form>}<details><summary><FileText size={14}/>查看原始 Markdown</summary><pre>{artifactBodies[index]}</pre></details></article>)}{task.agile_status === 'blocked' && questions.every((q) => q.status === 'answered') && <form action={releaseBlockAction}><input type="hidden" name="taskId" value={task.task_id}/><button className="button success">解除阻塞并交回 {task.current_subagent}</button></form>}</section>
    <section><h2>活动记录</h2><div className="timeline">{events.map((event) => <div key={event.event_id}><span/><p><b>{event.actor}</b> · {event.summary}</p><small>{event.created_at}</small></div>)}</div></section></>;
}
