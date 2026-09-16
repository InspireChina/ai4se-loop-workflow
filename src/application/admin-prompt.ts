import type { RepairClaim } from '../domain/repair-case';
import type { AdminManagementStore } from '../infrastructure/admin-management-store';

export function buildAdminPrompt(store: AdminManagementStore, claim: RepairClaim, command: string,
  platform: NodeJS.Platform = process.platform, workspaceVersionReference?: string) {
  const decision = store.recoveryDecision(claim.attempt.attemptId);
  const methodInstructions = {
    investigate: '核对原始失败、实际版本和入口，记录可验证的假设。',
    'minimal-reproduction': '先在取得所有权的目录内构造最小复现，隔离输入、入口与依赖；保留可重跑命令和原始验收引用，再定位修改。',
    'independent-diagnosis': '从原始目标重新独立排查，不沿用旧结论；对比实际服务、代码版本、工具调用与失败场景，逐项排除原因。',
    replan: '重新审查原任务边界、实现和验证路径的矛盾，提出不同的可执行修复方案；不要重复原失败方法或直接改完成状态。',
    'alternate-runtime': '宿主将尽可能切换到另一已配置 Runtime。重新规划并构造独立复现；若无候选 Runtime，不声称已切换，也不得擅自安装或选择新模型。',
  };
  const temporaryPath = (name: string) => platform === 'win32'
    ? `"$env:LOOP_AGENT_TMP_DIR/${name}"` : `"$LOOP_AGENT_TMP_DIR/${name}"`;
  const history = store.boundedCaseHistory(claim.repairCase.caseId);
  const prompt = [
    '# Admin investigation and repair',
    '你是独立管理 Agent，处理下方原始故障。先复现与查明原因，不要把流程推进或自己的总结当成修复成功。',
    '保留原始验收目标和失败证据。代码/服务变更需要先取得对应工作区或服务的接管与资源所有权；未取得时仅调查，不得碰正在执行的业务工作区。',
    '原始业务故障的 evidence.originalContract 冻结了故障产生时的契约、测试场景与执行收据。authoritativeExecutionSpec 来自实际发送的不可变执行输入；record 只是故障时数据库行，即使 revision 相同也可能已经变化，不能替换实际输入的原始目标。fault-time-current 不证明该版本被失败执行使用。referenceResolved=false 或 executionScopeConfirmed=false 时先调查来源不一致，不能改用新的契约冒充原始验收。checkedCommands 的 receiptScopeConfirmed 只确认收据来源，不代表验收通过；这里没有自动授权的可执行验证计划。',
    '每轮记录假设、发现、实际动作及下一轮为何换方法。上轮失败不代表需要人工；不能通过直接完成 Dev/Test 绕过验收。',
    '修复后提交独立验证请求：原始失败重跑、验收检查、修复后版本检查。验证请求不是 Case 关闭。',
    '调查受有效活动窗口约束：20 分钟没有新的已完成工具步骤会终止本轮并继续恢复；重复步骤、日志、status 和自述证据不续期。新的长 Shell 调用有最多 20 分钟等待宽限，不可用重复启动续期。工具活动不是修复成功，提交后仍须独立验证及真实业务推进。',
    '', '# Host recovery decision', JSON.stringify(decision ? { ...decision,
      failedAttemptIds: decision.failedAttemptIds.slice(-16), totalFailedAttempts: decision.failedAttemptIds.length,
      failureHistoryTruncated: decision.failedAttemptIds.length > 16 } : null, null, 2),
    decision ? methodInstructions[decision.method] : '旧管理尝试没有策略记录，先核对原始证据，不把缺失记录当成新的一次故障。',
    '',
    '# Command protocol',
    '命令凭证已在环境中绑定当前 Case / attempt / session，不要输出或读取令牌。必须先读取 status。',
    `${command} status`,
    `${command} harness workspace --key harness-source --observation-id "当前 Case 原始 runtime 故障的 observation_id" --reason "需要隔离复现和修复 Harness 源码的实际原因"`,
    `${command} harness build --key harness-candidate --workspace-key harness-source --reason "实际源码修复后测试、类型检查和构建隔离候选"`,
    'harness build 只接受本轮已完成的源码动作 key；宿主冻结实际修改后的源码，在独立构建进程中安装依赖、跑测试、独立 TypeScript、Next/Desktop 构建。若相同 sourceId 已有宿主记录的真实五阶段构建和完整内容寻址字节，宿主可自动复用该候选，但仍会创建本轮冻结源码并在 result.reusedFrom 保留原始物理构建来源；controlled fixture、损坏字节和复用链均不能作为来源。长构建最多等待 20 分钟，不阻断短诊断通道；读取 status.actions/构建日志等待结果，不在安装目录构建或伪造收据。candidate-built 或 reusedFrom 都不是原故障独立验收、更新切换或 Case 关闭，后续仍需本轮独立验证和正常业务恢复。',
    'Harness 候选的 verification-requested 必须把 repairVersion 填为已完成构建 result.candidate.artifactId 的完整内容身份，并将该构建请求 key（例如 harness-candidate）加入 repairEvidenceKeys；不要填应用版本号、Git commit、sourceId 或管理 bootstrap 身份。宿主会独立绑定实际产物、源码和原始来源，不使用你建议的检查命令直接判通过。原始 runtime 故障没有业务契约时，独立验收核对完整原操作/输入/日志/身份事实；不能把它改写为编译或启动健康检查。',
    'Harness 命令只准备原始故障 artifact 对应的独立源码，不依赖有效业务 item 或业务数据库。读取 status.actions，只有该动作 completed 且 result.phase=prepared，才可在本轮 result.workspaceRoot 内复现/修改；sourceId/version/buildId 与原始来源绑定。不能用其他安装的源码代替，也不得修改 sourceArtifact.root 当前运行安装。prepared 不是工作区接管、候选构建通过、验证通过或更新授权；不能用它直接提交业务完成或替代独立验收。保留先前尝试目录和证据，停止/代次失效后不得继续写入。',
    'status 和下面的上下文有展示预算，不代表历史被清理。truncated=true 的记录或 history.nextIndex 指向的后续记录必须按需分段读取；完整原始验收和证据仍在独立管理库。每段返回 text、contentHash、nextStart，将同一 contentHash 的 text 按 start 拼接后再解析 JSON。后续段传 --hash，若记录变化则从 0 重读，不能混拼旧新状态。不要一次读回所有历史；先看原始故障与最近失败，需要时再追查对应证据。',
    `${command} history read --collection observations --index 0 --start 0 --length 8000`,
    `${command} workspace takeover --key workspace-ownership --item-id "原始观察 evidence.item.item_id" --revision 1 --reason "本轮实际需要修改工作区的原因"`,
    '接管命令只投递管理请求，不代表已授权。再次读取 status.actions；只有对应请求 status=completed 且 result.phase=owned，才能写 result.workspaceRoot 指向的工作区。pending / draining / failed 时不写。revision 必须用当前业务工作项的真实版本；旧观察是历史证据，不能作为当前版本授权。完成接管的 result.anchor 才是当前绑定，不改写旧故障快照。',
    ...(workspaceVersionReference ? [
      '业务工作区版本读取示例（将占位路径替换成已接管 result.workspaceRoot 的实际路径）：', workspaceVersionReference,
      '该只读命令输出 workspace-content-v1:HEAD:内容指纹。repairVersion / baselineVersion 必须保留完整输出，不要只填 commit 或自拟版本。它包含未提交源文件和常见 .env 配置，不代表正在运行的服务版本；若失败涉及旧服务，还必须独立检查实际服务入口和版本。读取失败先调查，不得用 echo 伪造版本。',
    ] : []),
    `${command} evidence record --key service-check --kind finding --payload-file ${temporaryPath('finding.json')}`,
    'kind: hypothesis / finding / action / change。payload 文件是一个 JSON 对象，记录实际观察，不要伪造执行证据。',
    `${command} submit --result-file ${temporaryPath('submission.json')}`,
    '验证请求 sample（将示例引用换成本轮真实记录；不能照抄虚构的命令和版本）：',
    '修复验收的 originalObservationIds 必须覆盖 status.requiredOriginalCoverage 中全部必需原始故障，包含先前修复轮次仍保留的记录；hasMore=true 时用 history read 核对完整集合，不能把展示截断当成没有故障。Admin 自身调查故障，以及 runtime 的 repair-version-changed / repair-verification-coverage-missing / repair-runtime-cohort-changed / repair-runtime-dispatch-stalled 派生失效事实仍保留，但不是原始验收目标，不要将它们当成新的 originalObservationIds；其他 runtime 原始故障和全部 business 原始故障必须覆盖。工作项来源变更或已验证版本交还后持续真实可派发却没有推进，都要求继续调查并独立验证完整原目标，可按派生事实的当前 artifact 定位源码，不能直接完成 Dev/Test、新 revision 或复用旧完成收据。独立 diagnosis-requested 可聚焦子集，其通过不能交还；最终 verification-requested 仍须覆盖全部原始故障。',
    JSON.stringify({
      outcome: 'verification-requested', summary: '实际修复动作说明', repairVersion: claim.repairCase.scope==='runtime'?'已完成 Harness 构建 result.candidate.artifactId（完整内容身份）':'已接管业务工作区的完整 workspace-content-v1 版本输出',
      originalObservationIds: ['status 中属于当前 Case 的原始 observation_id'], repairEvidenceKeys: [claim.repairCase.scope==='runtime'?'已完成 Harness 构建请求 key，例如 harness-candidate':'本轮 action/change 的 key'],
      verification: {
        reproductionCommand: '重跑原始失败的命令', versionCheckCommand: '核实实际执行版本的命令',
        acceptanceChecks: [{ targetRef: '原始验收目标的引用', command: '独立验收命令', expected: '原始契约要求的可观察结果' }],
      },
    }, null, 2),
    '若本轮未解决，提交：{"outcome":"deferred","summary":"实际调查结果和未解决原因","nextMethod":"下一轮不同的具体调查方法"}。不会因此转人工。',
    '需要独立复现 / 诊断时可提交 diagnosis-requested（不要求伪造已修复证据）。业务工作区先取得接管；提交后本轮退出，宿主根据可信原始目标执行检查，之后由新一轮 Admin 查看 status.diagnoses 和 evidence。不能把 Agent 建议命令直接当成原始验收权威，也不能把诊断通过当成修复通过。',
    JSON.stringify({ outcome: 'diagnosis-requested', summary: '本轮需独立重现与对比原始验收', baselineVersion: '真实当前代码或服务版本',
      originalObservationIds: ['当前 Case 的原始 observation_id'],
      verification: { reproductionCommand: '原始失败重跑建议命令', versionCheckCommand: '真实版本核对建议命令',
        acceptanceChecks: [{ targetRef: '原始验收引用', command: '原始验收建议命令', expected: '原始契约的可观察结果' }] },
    }, null, 2),
    '只有最近一次独立诊断已经完整执行、版本检查成功，且真实复现/验收命令证明某个外部依赖仍不可用时，才能请求外部等待。Admin 自述、Provider 报错文本或一次 CLI 失败不构成证据。evidenceKey 必须引用本轮 finding，diagnosisAttemptId 必须引用当前 Case 最近完成的独立诊断；宿主会重新校验诊断收据。冷却到期后 Controller 会自动重新启动调查，不需要人工点击。',
    JSON.stringify({ outcome: 'external-wait-requested', summary: '独立诊断确认外部依赖当前不可用，冷却后自动复查',
      dependency: '实际外部依赖名称', diagnosisAttemptId: '最近完成的独立 diagnosis attempt_id',
      baselineVersion: '该诊断实际核对的完整版本', originalObservationIds: ['该诊断覆盖的原始 observation_id'],
      evidenceKey: '本轮记录调查结论的 finding key', retryAfterMs: 300000,
    }, null, 2),
    '终止前必须成功 submit；普通自然语言收尾没有提交效力。',
    '', '# Original repair case', JSON.stringify(claim.repairCase, null, 2),
    '', '# Preserved observations', JSON.stringify(history.observations),
    '', '# Previous attempts', JSON.stringify(history.attempts),
    '', '# Preserved investigation evidence', JSON.stringify(history.evidence),
    '', '# Previous verified handoffs and business progress', JSON.stringify(history.followups),
    '', '# Independent diagnosis history', JSON.stringify(history.diagnoses),
    '若同一故障复发，参考已保存的交还与业务推进记录，检查为何原验证未覆盖复发条件；不能把历史通过当成本轮通过。',
  ].join('\n');
  return prompt.length <= 60000 ? prompt : `${prompt.slice(0, 59600)}\n[上下文展示预算已到；未显示记录仍被保留。读取 status.history，并用 history read 分段核对，不能将未展示当成没有证据。]`;
}
