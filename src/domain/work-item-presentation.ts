import type { WorkItemStatus } from './workflow-item';

const directStates: Record<WorkItemStatus, { label: string; detail: string }> = {
  pending: { label: '等待依赖', detail: 'Direct 工作项等待前置条件完成' },
  ready: { label: '等待执行', detail: 'Direct 工作项已就绪，等待派发 Agent' },
  running: { label: '运行中', detail: 'Direct Agent 正在执行当前需求' },
  waiting: { label: '等待处理', detail: 'Direct 工作项等待输入或介入处理，当前执行已挂起' },
  completed: { label: '已提交', detail: 'Direct 工作项已完成并提交最终结果' },
  cancelled: { label: '已取消', detail: 'Direct 工作项已取消，不再派发执行' },
  superseded: { label: '已换代', detail: 'Direct 工作项已被新版本替代' },
};

/** Display graph state, never infer a running Agent from a legacy task cursor. */
export function directWorkItemPresentation(status: WorkItemStatus | undefined, paused: boolean) {
  if (paused && status !== 'completed' && status !== 'cancelled' && status !== 'superseded') {
    return { label: '已暂停', detail: 'Direct 工作项已暂停，恢复后重新调度' };
  }
  return status ? directStates[status] : {
    label: '等待工作项', detail: '尚未建立当前 Direct 工作项，等待工作图恢复',
  };
}
