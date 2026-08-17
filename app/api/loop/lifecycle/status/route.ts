import { NextResponse } from 'next/server';
import { webLoopRunLifecycle } from '../../../../../src/application/loop-run-lifecycle';

export const dynamic = 'force-dynamic';

export async function GET() {
  const lifecycle = await webLoopRunLifecycle();
  return NextResponse.json(await lifecycle.status());
}
