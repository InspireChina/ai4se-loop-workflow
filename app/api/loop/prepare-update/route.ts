import { NextRequest, NextResponse } from 'next/server';
import { prepareLoopForDesktopUpdate } from '../../../../src/application/run-supervisor';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const expected = process.env.LOOP_SUPERVISOR_TOKEN;
  if (!expected || request.headers.get('x-loopwork-supervisor') !== expected) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json(await prepareLoopForDesktopUpdate());
}
