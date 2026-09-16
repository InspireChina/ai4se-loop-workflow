'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { arbitrateInterventionAction } from '../../actions';

export function ArbitrationControl({ taskId, interventionId, canComplete, targets }: {
  taskId: string; interventionId: string; canComplete: boolean; targets: { key: string; label: string }[];
}) {
  const router = useRouter();
  const [command, setCommand] = useState('task-rewind');
  const [state, action, pending] = useActionState(arbitrateInterventionAction, { ok: false, message: '' });
  useEffect(() => { if (state.ok) router.refresh(); }, [state, router]);
  return <details>
    <summary>人工仲裁处理</summary>
    <form action={action} className="form-panel">
      <input type="hidden" name="taskId" value={taskId}/>
      <input type="hidden" name="interventionId" value={interventionId}/>
      <label>裁决操作<select name="command" value={command} onChange={(event) => setCommand(event.target.value)} disabled={pending}>
        <option value="task-rewind">回退工作项并重新执行</option>
        {canComplete && <option value="work-item-complete">仲裁完成当前 Dev/Test 步骤</option>}
      </select></label>
      {command === 'task-rewind' && <label>回退到<select name="to" required disabled={pending}>
        {targets.map((target) => <option key={target.key} value={target.key}>{target.label}</option>)}
      </select></label>}
      <label>裁决依据与证据<textarea name="reason" required maxLength={20_000} rows={4} disabled={pending}
        placeholder="说明矛盾、核对过的契约或执行证据，以及这样处置的依据。"/></label>
      <p className="muted">完成步骤只改变流程处置，不会将原始失败改成测试通过。回退会取消受影响执行并保留历史。</p>
      {state.message && <p role="status" className={state.ok ? 'muted' : 'recommendation'}>{state.message}</p>}
      <button type="submit" disabled={pending || !targets.length}>{pending ? '正在提交裁决…' : '提交人工裁决'}</button>
    </form>
  </details>;
}
