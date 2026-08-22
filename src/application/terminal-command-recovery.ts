import { sanitizeDiagnosticText } from '../infrastructure/diagnostic-text';

export type CleanExitContinuationCandidate = {
  exitCode: number;
  hasSubmission: boolean;
  cancelled: boolean;
  evidencePersistenceError?: string | null;
};

export function shouldContinueAfterCleanExit(candidate: CleanExitContinuationCandidate) {
  return candidate.exitCode === 0
    && !candidate.hasSubmission
    && !candidate.cancelled
    && !candidate.evidencePersistenceError;
}

export function buildCleanExitContinuationPrompt(input: {
  originalPrompt: string;
  previousFinalText: string;
  continuationNumber: number;
}) {
  const previousFinalText = sanitizeDiagnosticText(input.previousFinalText, 4_000) || '（上一轮没有可保留的最终文本）';
  return [
    `# Clean Exit Continuation · ${input.continuationNumber}`,
    '',
    '上一轮 CLI 以 exit 0 正常退出，但没有成功执行角色终止命令。不能据此假定工作已经完成；上一轮可能停在命令链的任意阶段。',
    '继续同一个 execution 和原始委派，不要另起任务。渐进式角色必须先执行 status，按返回的当前阶段、NEXT 和 NEXT WORK PACKET 从持久化草稿继续；Direct 角色则检查当前真实结果并继续 RUN → SUBMIT。',
    '允许完成尚未完成的分析、实现、命令、长时间测试、校验和提交步骤。不要限制为补交，也不要跳过命令链中的剩余阶段。',
    '只有成功执行原始契约列出的角色终止命令才可以结束；普通总结、阶段完成、测试完成或自然语言“已完成”都不是终止提交。',
    '',
    '# Original Delegation Contract',
    input.originalPrompt,
    '',
    '# Previous Final Text (evidence only)',
    '下面内容只说明上一轮停止前说了什么，不证明对应工作或终止提交已经完成：',
    previousFinalText,
  ].join('\n');
}
