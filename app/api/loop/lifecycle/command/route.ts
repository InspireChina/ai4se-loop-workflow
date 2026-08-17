import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { webLoopRunLifecycle, type LifecycleAction } from '../../../../../src/application/loop-run-lifecycle';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const action = await request.json() as LifecycleAction;
    let safeAction: LifecycleAction;
    if (action?.kind === 'start') safeAction = { kind: 'start' };
    else if (action?.kind === 'stop') safeAction = { kind: 'stop', reason: 'user-stop' };
    else if (action?.kind === 'resume-after-update') safeAction = { kind: 'resume-after-update' };
    else return NextResponse.json({ error: 'unsupported lifecycle action' }, { status: 400 });
    const lifecycle = await webLoopRunLifecycle();
    const receipt = await lifecycle.command({
      requestId: randomUUID(),
      source: { adapter: 'ui', instanceId: `web-${process.pid}`, actor: 'human' },
      action: safeAction,
    });
    return NextResponse.json(receipt, { status: receipt.outcome === 'failed' || receipt.outcome === 'blocked' ? 409 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
