export type RuntimeCliProcess = {
  allocationId: string; hostAllocationId: string; executionId: string; ownerPid: number;
  pid: number | null; marker: string | null; groupId: number | null;
  status: 'launching' | 'running' | 'terminating' | 'exited';
};
