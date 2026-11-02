import { isAllowedLocalRequestOrigin } from '../../../src/infrastructure/local-request-origin';
export async function POST(request: Request) {
  if (!isAllowedLocalRequestOrigin(request)) return Response.json({ error: 'Origin 不匹配' }, { status: 403 });
  return Response.json({ error: 'DJI Web 使用全新数据目录，不提供历史数据库导入' }, { status: 410 });
}
export async function GET() { return Response.json({ supported: false }); }
