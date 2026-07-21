'use client';

import { useRef, useState } from 'react';
import { MessageSquare, Quote, RotateCcw } from 'lucide-react';
import type { DocumentComment } from '../../../src/application/tasks';
import { MarkdownContent } from '../../../src/ui/markdown-content';
import { addDocumentCommentAction, reopenDocumentCommentAction } from '../../actions';

type SelectionAnchor = {
  quotedText: string;
  startOffset: number;
  endOffset: number;
};

export function ArtifactDocument({
  taskId,
  documentId,
  content,
  format,
  revision,
  comments,
  allowReopen = true,
  allowComment = true,
}: {
  taskId: string;
  documentId: string;
  content: string;
  format: string;
  revision: number;
  comments: DocumentComment[];
  allowReopen?: boolean;
  allowComment?: boolean;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);

  function captureSelection() {
    const selection = window.getSelection();
    const preview = previewRef.current;
    if (!selection || !preview || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!preview.contains(range.commonAncestorContainer)) return;
    const quotedText = selection.toString().trim().slice(0, 4000);
    if (!quotedText) return;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(preview);
    prefix.setEnd(range.startContainer, range.startOffset);
    const startOffset = prefix.toString().length;
    setAnchor({ quotedText, startOffset, endOffset: startOffset + selection.toString().length });
  }

  return <div className="artifact-document">
    <div className="artifact-preview" ref={previewRef} onMouseUp={captureSelection}>
      {format === 'markdown' ? <MarkdownContent content={content}/> : <pre>{content}</pre>}
    </div>

    <details className="artifact-source">
      <summary>查看原始内容 · revision {revision}</summary>
      <pre>{content}</pre>
    </details>

    <div className="artifact-feedback">
      <div className="artifact-feedback-head">
        <div>
          <strong><MessageSquare size={15}/>评论产出</strong>
          <small>直接评论整个文件，或先在预览中选中文字。</small>
        </div>
        {anchor && <button className="text-button" type="button" onClick={() => setAnchor(null)}><RotateCcw size={13}/>改为文件级</button>}
      </div>
      {allowComment && <form action={addDocumentCommentAction} className="artifact-comment-form">
        <input type="hidden" name="taskId" value={taskId}/>
        <input type="hidden" name="documentId" value={documentId}/>
        <input type="hidden" name="anchorType" value={anchor ? 'selection' : 'file'}/>
        <input type="hidden" name="quotedText" value={anchor?.quotedText || ''}/>
        <input type="hidden" name="startOffset" value={anchor?.startOffset ?? ''}/>
        <input type="hidden" name="endOffset" value={anchor?.endOffset ?? ''}/>
        {anchor ? <blockquote className="comment-anchor"><Quote size={13}/><span>{anchor.quotedText}</span></blockquote> : <p className="comment-anchor file-anchor"><MessageSquare size={13}/>评论整个文件</p>}
        <label>反馈意图<select name="intent" defaultValue="change_request">
          <option value="change_request">要求修改</option>
          <option value="question">需要回复</option>
          <option value="note">备注或建议</option>
        </select></label>
        <textarea name="content" required maxLength={4000} placeholder="指出需要修改的内容、原因或希望以后采用的做法…"/>
        <button className="button secondary" type="submit">提交评论</button>
      </form>}

      {comments.length > 0 && <div className="artifact-comments">
        {comments.map((comment) => <article className={`artifact-comment ${comment.status}`} key={comment.comment_id}>
          <div className="artifact-comment-meta">
            <span>{comment.anchor_type === 'selection' ? '选区评论' : '文件评论'} · revision {comment.document_revision}</span>
            <small>{comment.feedback_status === 'resolved' ? '已解决' : comment.feedback_status === 'verifying' ? '等待反馈验证' : comment.feedback_status === 'in_progress' ? '处理中' : comment.feedback_status === 'triaged' ? '已分流' : comment.feedback_status === 'reopened' ? '已重新打开' : '等待分流'} · {comment.intent === 'change_request' ? '要求修改' : comment.intent === 'question' ? '需要回复' : '备注建议'} · {comment.evolution_status === 'analyzed' ? '已用于演化分析' : '尚未沉淀'}</small>
          </div>
          {comment.quoted_text && <blockquote className="comment-anchor"><Quote size={13}/><span>{comment.quoted_text}</span></blockquote>}
          <p>{comment.content}</p>
          {comment.triage_reason && <p className="muted"><b>分流结论：</b>{comment.triage_reason}</p>}
          {comment.resolution_claim_json && <details><summary>处理声明</summary><pre>{JSON.stringify(JSON.parse(comment.resolution_claim_json), null, 2)}</pre></details>}
          {comment.verification_json && <details><summary>反馈验证</summary><pre>{JSON.stringify(JSON.parse(comment.verification_json), null, 2)}</pre></details>}
          {comment.feedback_status === 'resolved' && allowReopen && <form action={reopenDocumentCommentAction}>
            <input type="hidden" name="taskId" value={taskId}/>
            <input type="hidden" name="commentId" value={comment.comment_id}/>
            <button className="text-button" type="submit"><RotateCcw size={13}/>重新打开</button>
          </form>}
        </article>)}
      </div>}
    </div>
  </div>;
}
