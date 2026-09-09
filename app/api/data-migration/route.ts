import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { ensureAgentRuntimeWorkspace } from '../../../src/application/agent-profiles';
import { scanAndImportLegacyProjectDatabases } from '../../../src/infrastructure/database';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== requestUrl.origin) {
    return NextResponse.json({ error: 'Origin 不匹配' }, { status: 403 });
  }
  try {
    const report = await scanAndImportLegacyProjectDatabases();
    if (report.imported > 0) await ensureAgentRuntimeWorkspace();
    revalidatePath('/', 'layout');
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
