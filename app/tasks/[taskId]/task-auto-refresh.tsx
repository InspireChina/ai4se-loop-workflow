'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

const REFRESH_INTERVAL_MS = 30_000;

export function TaskAutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const interval = window.setInterval(refreshWhenVisible, REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [router]);

  return <span className="task-auto-refresh" aria-label="自动刷新已开启" title="自动刷新已开启：页面可见时每 30 秒获取一次最新状态">
    <RefreshCw size={14}/>
  </span>;
}
