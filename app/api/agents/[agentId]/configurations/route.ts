import { NextResponse } from 'next/server';
import { getAgentCommandFile, saveAgentCommandScript, validateAgentCommandFile } from '../../../../../src/application/agent-configurations';
import { isAllowedLocalRequestOrigin } from '../../../../../src/infrastructure/local-request-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
}

export async function GET(_request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await context.params;
    return NextResponse.json({ source: getAgentCommandFile(agentId) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  if (!isAllowedLocalRequestOrigin(request)) return NextResponse.json({ error: '不允许跨来源修改命令脚本' }, { status: 403 });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return NextResponse.json({ error: '请使用 application/json' }, { status: 415 });
  try {
    const { agentId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    if (body.action === 'save') return NextResponse.json({ source: saveAgentCommandScript(agentId, {
      relativePath: body.relativePath, content: body.content, expectedHash: body.expectedHash,
    }) });
    if (body.action !== 'validate') return NextResponse.json({ error: '仅支持脚本语法校验和保存外部源文件' }, { status: 405 });
    validateAgentCommandFile(agentId, body.content);
    return NextResponse.json({ valid: true, scope: 'syntax' });
  } catch (error) { return errorResponse(error); }
}
