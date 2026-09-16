export class OriginalCoverageMissing extends Error {
  constructor(readonly missingCount: number, readonly missingObservationIds: string[]) {
    super(`修复验收遗漏 ${missingCount} 条原始故障：${JSON.stringify(missingObservationIds)}${missingCount > missingObservationIds.length ? '；其余通过 history read 分段核对' : ''}。不能选择性验证；独立诊断可聚焦子集，但不能据此交还。`);
    this.name = 'OriginalCoverageMissing';
  }
}
