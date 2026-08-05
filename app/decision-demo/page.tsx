import { redirect } from 'next/navigation';

export default async function LegacyDecisionDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ taskId?: string | string[] }>;
}) {
  const params = await searchParams;
  const taskId = typeof params.taskId === 'string' ? params.taskId : null;
  redirect(taskId ? `/decisions?taskId=${encodeURIComponent(taskId)}` : '/tasks');
}
