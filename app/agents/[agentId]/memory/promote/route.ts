import { NextResponse } from 'next/server';
import { promoteDailyMemoryObservation } from '../../../../../src/application/agent-profiles';
import { isAllowedLocalRequestOrigin } from '../../../../../src/infrastructure/local-request-origin';

function memoryPage(request: Request, agentId: string, projectId: string, parameters: Record<string, string>) {
  const url = new URL(`/agents/${agentId}`, request.url);
  url.searchParams.set('section', 'memory');
  if (projectId) url.searchParams.set('project', projectId);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  let projectId = '';
  if (!isAllowedLocalRequestOrigin(request)) {
    return NextResponse.json({ error: 'Origin 不匹配' }, { status: 403 });
  }
  try {
    const formData = await request.formData();
    projectId = String(formData.get('projectId') || '');
    await promoteDailyMemoryObservation({
      projectId,
      agentId,
      memoryName: formData.get('memoryName'),
      executionId: formData.get('executionId'),
      fingerprint: formData.get('fingerprint'),
    });
    return NextResponse.redirect(memoryPage(request, agentId, projectId, { memoryPromoted: '1' }), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return NextResponse.redirect(memoryPage(request, agentId, projectId, { memoryError: message.slice(0, 300) }), 303);
  }
}
