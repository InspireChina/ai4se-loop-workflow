import { readFileSync } from 'node:fs';
import { databaseConnection } from '../../../../../src/infrastructure/database';
import { listDecisionTreeFiles } from '../../../../../src/infrastructure/decision-tree-files';

export const dynamic = 'force-dynamic';

/** Read only the tree indexed under this task, never a caller-supplied file path. */
export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const query = new URL(request.url).searchParams;
  const kind = query.get('kind') || 'questions';
  const scope = query.get('scope') || taskId;
  const file = listDecisionTreeFiles(await databaseConnection(), taskId).find(file => file.kind === kind && file.scopeId === scope);
  if (!file) return Response.json({ error: '决策树文件不存在' }, { status: 404 });
  return new Response(readFileSync(file.path, 'utf8'), { headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${query.get('download') === '1' ? 'attachment' : 'inline'}; filename="decision-tree.json"`,
  } });
}
