'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';

type CopyStatus = 'idle' | 'copied' | 'error';

async function writeClipboard(content: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = content;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('clipboard unavailable');
}

export function CopyButton({ content, label = '复制内容' }: { content: string; label?: string }) {
  const [status, setStatus] = useState<CopyStatus>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const timer = window.setTimeout(() => setStatus('idle'), 2200);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function copy() {
    try {
      await writeClipboard(content);
      setStatus('copied');
    } catch {
      setStatus('error');
    }
  }

  const text = status === 'copied' ? '已复制' : status === 'error' ? '复制失败' : label;
  return <button
    type="button"
    className={`copy-button ${status}`}
    onClick={copy}
    title={status === 'error' ? '无法访问剪贴板，请重试' : label}
    aria-live="polite"
  >
    {status === 'copied' ? <Check size={13}/> : status === 'error' ? <TriangleAlert size={13}/> : <Copy size={13}/>}
    {text}
  </button>;
}
