import { NextResponse } from 'next/server';
import { promoteDailyMemoryObservation } from '../../../../../src/application/agent-profiles';

function memoryPage(request: Request, agentId: string, parameters: Record<string, string>) {
  const url = new URL(`/agents/${agentId}`, request.url);
  url.searchParams.set('section', 'memory');
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== requestUrl.origin) {
    return NextResponse.json({ error: 'Origin 不匹配' }, { status: 403 });
  }
  try {
    const formData = await request.formData();
    await promoteDailyMemoryObservation({
      agentId,
      memoryName: formData.get('memoryName'),
      executionId: formData.get('executionId'),
      fingerprint: formData.get('fingerprint'),
    });
    return NextResponse.redirect(memoryPage(request, agentId, { memoryPromoted: '1' }), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return NextResponse.redirect(memoryPage(request, agentId, { memoryError: message.slice(0, 300) }), 303);
  }
}
