'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

const FALLBACK_REFRESH_INTERVAL_MS = 60_000;
const REFRESH_DEBOUNCE_MS = 250;

export function TaskAutoRefresh({ taskId }: { taskId?: string }) {
  const router = useRouter();

  useEffect(() => {
    let refreshTimer: number | undefined;
    const requestRefresh = () => {
      if (document.visibilityState !== 'visible' || refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    };
    const handleRefresh = (message: Event) => {
      if (taskId && message instanceof MessageEvent) {
        try {
          const data = JSON.parse(message.data) as { entityId?: string };
          if (data.entityId && data.entityId !== taskId) return;
        } catch {
          // Invalid payloads are harmless; refresh to converge on server state.
        }
      }
      requestRefresh();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') requestRefresh();
    };

    const source = new EventSource('/api/tasks/events');
    source.addEventListener('refresh', handleRefresh);
    const fallbackInterval = window.setInterval(refreshWhenVisible, FALLBACK_REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      source.removeEventListener('refresh', handleRefresh);
      source.close();
      window.clearInterval(fallbackInterval);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [router, taskId]);

  return <span
    className="task-auto-refresh"
    aria-label="自动刷新已开启"
    title="事件驱动自动刷新已开启；连接异常时每 60 秒兜底刷新"
  >
    <RefreshCw size={14}/>
  </span>;
}
