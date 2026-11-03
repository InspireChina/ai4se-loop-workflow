/** 共享原始源码：由同目录命令入口调用。修改会作用于引用它的流程角色；不要在模块加载时执行任务副作用。 */
module.exports = function createCommandChainRuntime(harness) {
  const { createHash, randomUUID, parse, stringify, agentResultSchema, deliverySpecSchema, AgentCommandValidationError, loopAgentCommandPrefix, loadCommandChainDefinition, deliveryUnitContractSchema, analysisDecisionMode, parseRequirementMetadata, requirementMetadataDefinition, requirementMetadataValueLabel, validateScript, buildScriptResult } = harness;
  function required(flags, name) {
      const value = flags.get(name)?.trim();
      if (!value)
          throw new Error(`缺少 --${name}${name === 'content' ? '；原生 loopwork 可在 args 增加 --content-file、@input 两项，并同时用 input 传完整正文。不要只传 input 而让正文未绑定到命令。' : ''}`);
      return value;
  }
  function bounded(value, label, max = 20_000) {
      const normalized = value.trim();
      if (!normalized)
          throw new Error(`${label}不能为空`);
      if (normalized.length > max)
          throw new Error(`${label}不能超过 ${max} 个字符`);
      return normalized;
  }
  function chainState(db, draftId) {
      return db.prepare(`
      SELECT command_chain_id, definition_version, workflow_phase, validated_change_seq
      FROM command_chain_drafts WHERE draft_id = ?
    `).get(draftId);
  }
  function artifactRows(db, draftId) {
      return db.prepare(`
      SELECT artifact_id, block_id, item_key, content_format, content, ordinal
      FROM command_chain_artifact_blocks
      WHERE draft_id = ?
      ORDER BY artifact_id, block_id, ordinal, item_key
    `).all(draftId);
  }
  function acceptanceDraftItems(db, draftId) {
      return db.prepare(`
      SELECT acceptance_key, statement, oracle, source, ordinal
      FROM command_chain_acceptance_items
      WHERE draft_id = ? ORDER BY ordinal, acceptance_key
    `).all(draftId);
  }
  function activeRequirementAcceptances(db, taskId) {
      return db.prepare(`
      SELECT acceptance_id, acceptance_key, scope_type, story_index, statement,
             oracle, source_ref, revision
      FROM acceptances
      WHERE task_id = ? AND scope_type = 'requirement' AND lifecycle = 'active'
      ORDER BY acceptance_key
    `).all(taskId);
  }
  function activeTaskAcceptances(db, taskId) {
      return db.prepare(`
      SELECT acceptance_id, acceptance_key, scope_type, story_index, statement,
             oracle, source_ref, revision
      FROM acceptances
      WHERE task_id = ? AND lifecycle = 'active'
      ORDER BY scope_type, story_index, acceptance_key
    `).all(taskId);
  }
  function deliveryUnitAcceptances(db, taskId, storyIndex) {
      return db.prepare(`
      SELECT acceptance.acceptance_id, acceptance.acceptance_key, acceptance.scope_type,
             acceptance.story_index, acceptance.statement, acceptance.oracle,
             acceptance.source_ref, acceptance.revision
      FROM delivery_unit_acceptances link
      JOIN acceptances acceptance ON acceptance.acceptance_id = link.acceptance_id
      WHERE link.task_id = ? AND link.story_index = ? AND acceptance.lifecycle = 'active'
      ORDER BY CASE link.relation WHEN 'assigned' THEN 0 ELSE 1 END, acceptance.acceptance_key
    `).all(taskId, storyIndex);
  }
  function acceptanceAssessments(db, draftId, kind) {
      return db.prepare(`
      SELECT assessment.acceptance_id, acceptance.acceptance_key, assessment.kind,
             assessment.agent, assessment.execution_id, assessment.result, assessment.evidence
      FROM acceptance_assessments assessment
      JOIN acceptances acceptance ON acceptance.acceptance_id = assessment.acceptance_id
      WHERE assessment.draft_id = ?
        AND (? IS NULL OR assessment.kind = ?)
      ORDER BY acceptance.acceptance_key, assessment.created_at
    `).all(draftId, kind || null, kind || null);
  }
  function publishRequirementAcceptances(db, draft) {
      const items = acceptanceDraftItems(db, draft.draft_id);
      const keys = new Set(items.map((item) => item.acceptance_key));
      const existing = activeRequirementAcceptances(db, draft.task_id);
      for (const acceptance of existing) {
          if (!keys.has(acceptance.acceptance_key)) {
              db.prepare(`
          UPDATE acceptances SET lifecycle = 'superseded', updated_at = CURRENT_TIMESTAMP
          WHERE acceptance_id = ?
        `).run(acceptance.acceptance_id);
          }
      }
      for (const item of items) {
          const current = db.prepare(`
        SELECT acceptance_id, revision, statement, oracle, source_ref
        FROM acceptances WHERE task_id = ? AND acceptance_key = ?
      `).get(draft.task_id, item.acceptance_key);
          const sourceRef = `REQUIREMENT:${draft.task_id}:acceptance:${item.acceptance_key}`;
          if (current) {
              const changed = current.statement !== item.statement
                  || current.oracle !== item.oracle
                  || current.source_ref !== sourceRef;
              db.prepare(`
          UPDATE acceptances
          SET scope_type = 'requirement', story_index = NULL, statement = ?, oracle = ?,
              source_ref = ?, source_command_chain_draft_id = ?,
              revision = revision + ?, lifecycle = 'active', updated_at = CURRENT_TIMESTAMP
          WHERE acceptance_id = ?
        `).run(item.statement, item.oracle, sourceRef, draft.draft_id, changed ? 1 : 0, current.acceptance_id);
          }
          else {
              db.prepare(`
          INSERT INTO acceptances(
            acceptance_id, task_id, acceptance_key, scope_type, story_index,
            statement, oracle, source_ref, source_command_chain_draft_id
          ) VALUES(?, ?, ?, 'requirement', NULL, ?, ?, ?, ?)
        `).run(randomUUID(), draft.task_id, item.acceptance_key, item.statement, item.oracle, sourceRef, draft.draft_id);
          }
      }
  }
  function decisionRows(db, draftId) {
      return db.prepare(`
      SELECT tree_id, decision_key, content, status, selected_option_id, authority,
             decision_text, rationale, evidence, human_requested, ordinal
      FROM command_chain_decisions
      WHERE draft_id = ? ORDER BY tree_id, ordinal, decision_key
    `).all(draftId);
  }
  function checkRows(db, draftId) {
      return db.prepare(`
      SELECT check_key, command, command_hash, summary, source_execution_id,
             source_receipt_key, ordinal
      FROM command_chain_checks
      WHERE draft_id = ? ORDER BY ordinal, check_key
    `).all(draftId);
  }
  function commandFromValue(value) {
      if (typeof value === 'string')
          return value.trim();
      if (!value || typeof value !== 'object' || Array.isArray(value))
          return '';
      const record = value;
      for (const key of ['command', 'cmd', 'script']) {
          if (typeof record[key] === 'string')
              return record[key].trim();
      }
      return '';
  }
  function isHarnessCommand(command) {
      const normalized = command.replace(/\\/g, '/').toLowerCase();
      return normalized.startsWith('loopwork ')
          || normalized.includes('/scripts/loop/loop-agent.mjs')
          || normalized.includes(' loopctl -- agent-context')
          || normalized.includes(' agent-context ');
  }
  /** Only actual Shell / native browser-run receipts can support a check.
   * Workflow submissions, reads, browser navigation and self-reports cannot.
   * Tool success proves the operation ran; assertions remain in its evidence.
   */
  function capturedCommands(db, executionId) {
      const rows = db.prepare(`
      SELECT receipt_key, payload_json
      FROM execution_receipts
      WHERE execution_id = ? AND kind = 'tool_event'
      ORDER BY receipt_key
    `).all(executionId);
      const commands = [];
      for (const row of rows) {
          let event;
          try {
              event = JSON.parse(row.payload_json);
          }
          catch {
              continue;
          }
          if (event.name !== 'loop.agent.tool' || event.phase !== 'completed')
              continue;
          const command = commandFromValue(event.input);
          if (!command || isHarnessCommand(command))
              continue;
          const nativeBrowserRun = event.tool === 'browser' && event.toolClass === 'other' && command.startsWith('browser run ');
          if (event.toolClass !== 'shell' && !nativeBrowserRun)
              continue;
          commands.push({
              receiptKey: row.receipt_key,
              command: command.slice(0, 2000),
              commandHash: typeof event.commandHash === 'string' ? event.commandHash : '',
              passed: event.success === true && event.level !== 'ERROR',
              summary: (event.summary || (event.success === true ? '命令执行完成' : '命令执行失败或状态未知')).slice(0, 500),
          });
      }
      return commands;
  }
  function runtimeInputRows(db, draft) {
      const definition = definitionForDraft(draft);
      const inputs = db.prepare(`
      SELECT request_key, title, question, why, recommendation, ordinal
      FROM command_chain_runtime_inputs
      WHERE draft_id = ? ORDER BY ordinal, request_key
    `).all(draft.draft_id);
      const answers = db.prepare(`
      SELECT request_key, answer, status
      FROM runtime_input_requests
      WHERE task_id = ? AND story_index IS ? AND source_agent = ?
        AND request_key IS NOT NULL
      ORDER BY created_at, request_id
    `).all(draft.task_id, draft.story_index, definition.agent);
      const answerMap = new Map(answers.map((answer) => [answer.request_key, answer]));
      return inputs.map((input) => ({
          ...input,
          answer: answerMap.get(input.request_key)?.answer || null,
          answer_status: answerMap.get(input.request_key)?.status || null,
      }));
  }
  function activeRecoveries(db, draft) {
      return db.prepare(`
      SELECT recovery_id, summary
      FROM recovery_items
      WHERE task_id = ? AND story_index IS ?
        AND status IN ('pending', 'claimed', 'reopened')
      ORDER BY created_at, recovery_id
    `).all(draft.task_id, draft.story_index);
  }
  function developmentCriteria(spec) {
      return spec.acceptances.map((acceptance) => ({
          key: acceptance.key,
          description: acceptance.statement,
          oracle: acceptance.oracle,
          acceptanceId: acceptance.id,
      }));
  }
  function developmentEvidenceErrors(db, draft) {
      const errors = [];
      let expected = [];
      try {
          expected = developmentCriteria(currentDeliverySpec(db, draft.task_id, draft.story_index));
      }
      catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
      }
      const evidence = acceptanceAssessments(db, draft.draft_id, 'implementation');
      const expectedKeys = new Set(expected.map((criterion) => criterion.key));
      const unknown = evidence.map((item) => item.acceptance_key).filter((key) => !expectedKeys.has(key));
      const missing = expected.map((criterion) => criterion.key)
          .filter((key) => !evidence.some((item) => item.acceptance_key === key && item.result === 'claimed'));
      if (unknown.length)
          errors.push(`验收证据引用了不存在的 Delivery Spec key：${unknown.join(', ')}`);
      if (missing.length)
          errors.push(`以下验收语义尚未证明：${missing.join(', ')}`);
      return errors;
  }
  function developmentRecoveryErrors(db, draft) {
      const resolutions = new Set(artifactRows(db, draft.draft_id)
          .filter((artifact) => artifact.block_id === 'recovery-resolutions')
          .map((artifact) => artifact.item_key));
      const missing = activeRecoveries(db, draft).filter((recovery) => !resolutions.has(recovery.recovery_id));
      return missing.length
          ? [`以下活动恢复事项尚未声明处理：${missing.map((recovery) => recovery.recovery_id).join(', ')}`]
          : [];
  }
  function developmentCheckErrors(db, draft) {
      const recoveries = activeRecoveries(db, draft);
      const checks = checkRows(db, draft.draft_id);
      const eligible = recoveries.length
          ? checks.filter((check) => check.source_execution_id === draft.status_viewed_execution_id)
          : checks;
      const errors = [];
      if (!eligible.length) {
          errors.push(recoveries.length
              ? '当前处于恢复修正周期，至少需要在本次 execution 重新执行并记录一条真实成功检查'
              : '至少需要记录一条 Harness 捕获的真实成功检查');
      }
      const captured = capturedCommands(db, draft.status_viewed_execution_id || '');
      const superseded = eligible.filter((check) => captured.some((command) => command.commandHash === check.command_hash
          && (check.source_execution_id !== draft.status_viewed_execution_id
              || command.receiptKey > check.source_receipt_key)));
      if (superseded.length) {
          errors.push(`以下关键检查之后又执行了同一命令，必须选择最新结果重新记录：${superseded.map((check) => check.check_key).join(', ')}`);
      }
      return errors;
  }
  function touchDraft(db, draftId) {
      db.prepare(`
      UPDATE agent_work_drafts
      SET change_seq = change_seq + 1, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?
    `).run(draftId);
      db.prepare('UPDATE command_chain_drafts SET validated_change_seq = NULL WHERE draft_id = ?').run(draftId);
  }
  function nextOrdinal(db, table, draftId) {
      return db.prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM ${table} WHERE draft_id = ?`)
          .get(draftId).value;
  }
  function currentDeliveryUnit(db, taskId, storyIndex) {
      if (!storyIndex)
          throw new Error('当前命令链缺少交付单元');
      const unit = db.prepare(`
      SELECT unit_key, title, actor, trigger_condition, observable_outcome, acceptance
      FROM stories WHERE task_id = ? AND story_index = ?
    `).get(taskId, storyIndex);
      if (!unit)
          throw new Error(`交付单元不存在：${storyIndex}`);
      const missing = [unit.unit_key, unit.actor, unit.trigger_condition, unit.observable_outcome, unit.acceptance]
          .some((value) => !value?.trim());
      if (missing)
          throw new Error('交付单元契约不完整');
      const sources = db.prepare(`
      SELECT source_key, source_kind, content, source_ref
      FROM delivery_unit_context_links
      WHERE task_id = ? AND story_index = ? ORDER BY source_key
    `).all(taskId, storyIndex);
      if (!sources.length)
          throw new Error('交付单元没有可追溯的上游来源');
      const acceptances = deliveryUnitAcceptances(db, taskId, storyIndex);
      if (!acceptances.length)
          throw new Error('交付单元没有内置 Acceptance');
      const dependencies = db.prepare(`
      SELECT upstream.unit_key
      FROM delivery_unit_dependencies dependency
      JOIN stories upstream ON upstream.task_id = dependency.task_id
        AND upstream.story_index = dependency.depends_on_story_index
      WHERE dependency.task_id = ? AND dependency.story_index = ?
      ORDER BY dependency.depends_on_story_index
    `).all(taskId, storyIndex);
      if (dependencies.some((dependency) => !dependency.unit_key?.trim())) {
          throw new Error('前置交付单元缺少稳定 unit key');
      }
      return deliveryUnitContractSchema.parse({
          key: unit.unit_key,
          title: unit.title,
          actor: unit.actor,
          trigger: unit.trigger_condition,
          observableOutcome: unit.observable_outcome,
          acceptance: unit.acceptance,
          sourceRefs: sources.map((source) => ({
              key: source.source_key,
              kind: source.source_kind,
              content: source.content,
              sourceRef: source.source_ref,
          })),
          dependsOn: dependencies.map((dependency) => dependency.unit_key),
      });
  }
  /** 读取冻结 Delivery Spec；开发和独立测试共同承接此契约，不能在此重写业务目标。 */
  function currentDeliverySpec(db, taskId, storyIndex) {
      if (!storyIndex)
          throw new Error('当前命令链缺少交付单元');
      const row = db.prepare(`
      SELECT spec_json FROM story_specs
      WHERE task_id = ? AND story_index = ? AND status = 'resolved'
      ORDER BY revision DESC LIMIT 1
    `).get(taskId, storyIndex);
      if (!row)
          throw new Error('当前交付单元没有已收敛的 Delivery Spec');
      try {
          return deliverySpecSchema.parse(JSON.parse(row.spec_json));
      }
      catch (error) {
          throw new Error(`当前 Delivery Spec 无效：${error instanceof Error ? error.message : String(error)}`);
      }
  }
  function verificationInputSources(db, draft) {
      if (!draft.story_index)
          throw new Error('验证命令链缺少交付单元');
      const row = db.prepare(`
      SELECT revision, spec_json FROM story_specs
      WHERE task_id = ? AND story_index = ? AND status = 'resolved'
      ORDER BY revision DESC LIMIT 1
    `).get(draft.task_id, draft.story_index);
      if (!row)
          throw new Error('当前交付单元没有已收敛的 Delivery Spec');
      const spec = deliverySpecSchema.parse(JSON.parse(row.spec_json));
      const prefix = `DELIVERY_SPEC:${draft.task_id}:${draft.story_index}:r${row.revision}`;
      return [
          ...spec.acceptances.map((acceptance) => ({
              key: `acceptance:${acceptance.key}`,
              kind: 'acceptance',
              description: acceptance.statement,
              oracle: acceptance.oracle,
              sourceRef: `ACCEPTANCE:${acceptance.id}:r${acceptance.revision}`,
          })),
          ...spec.handoff.verificationFocus.map((focus) => ({
              key: `focus:${focus.key}`, kind: 'focus', description: focus.expected,
              oracle: focus.oracle, sourceRef: `${prefix}:focus:${focus.key}`,
          })),
          ...spec.handoff.guardrails.map((guardrail) => ({
              key: `guardrail:${guardrail.key}`, kind: 'guardrail', description: guardrail.content,
              oracle: guardrail.rationale, sourceRef: `${prefix}:guardrail:${guardrail.key}`,
          })),
          ...activeRecoveries(db, draft).map((recovery) => ({
              key: `recovery:${recovery.recovery_id}`, kind: 'recovery', description: recovery.summary,
              oracle: '原始失败不再复现，并且证据来自 Test Agent 的独立观察',
              sourceRef: `RECOVERY:${recovery.recovery_id}`,
          })),
      ];
  }
  function initializeVerificationInputs(db, draft) {
      const insert = db.prepare(`
      INSERT INTO command_chain_artifact_blocks(
        draft_id, artifact_id, block_id, item_key, content_format, content, ordinal
      ) VALUES(?, 'verification', 'sources', ?, 'yaml', ?, ?)
    `);
      for (const [index, source] of verificationInputSources(db, draft).entries()) {
          insert.run(draft.draft_id, source.key, stringify({
              kind: source.kind, description: source.description, oracle: source.oracle, sourceRef: source.sourceRef,
          }).trim(), index + 1);
      }
  }
  function verificationSourcesMatch(db, draft) {
      const expected = verificationInputSources(db, draft).map((source) => ({
          key: source.key,
          content: stringify({
              kind: source.kind, description: source.description, oracle: source.oracle, sourceRef: source.sourceRef,
          }).trim(),
      }));
      const actual = artifactRows(db, draft.draft_id)
          .filter((artifact) => artifact.artifact_id === 'verification' && artifact.block_id === 'sources')
          .map((artifact) => ({ key: artifact.item_key, content: artifact.content }));
      return JSON.stringify(actual) === JSON.stringify(expected);
  }
  function publishVerificationAssessments(db, draft, executionId) {
      const spec = currentDeliverySpec(db, draft.task_id, draft.story_index);
      const state = verificationState(decodedArtifacts(artifactRows(db, draft.draft_id)));
      for (const acceptance of spec.acceptances) {
          const sourceKey = `acceptance:${acceptance.key}`;
          const scenarios = state.scenarios.filter((scenario) => scenario.coverageRefs.includes(sourceKey));
          const results = scenarios.map((scenario) => ({
              scenario,
              result: state.results.find((candidate) => candidate.key === scenario.key),
          }));
          if (!results.length || results.some((item) => !item.result)) {
              throw new Error(`Acceptance ${acceptance.key} 缺少完整验证结果`);
          }
          const result = results.some((item) => item.result.status === 'failed')
              ? 'failed'
              : results.some((item) => item.result.status === 'blocked')
                  ? 'blocked'
                  : 'passed';
          const evidence = results.map((item) => `${item.scenario.key}: ${item.result.evidence}`).join('\n');
          const stored = db.prepare(`
        SELECT acceptance_id FROM acceptances
        WHERE acceptance_id = ? AND task_id = ? AND lifecycle = 'active'
      `).get(acceptance.id, draft.task_id);
          if (!stored)
              throw new Error(`Acceptance 实体不存在或已失效：${acceptance.key}`);
          db.prepare(`
        INSERT INTO acceptance_assessments(
          assessment_id, draft_id, acceptance_id, task_id, story_index,
          kind, agent, execution_id, result, evidence
        ) VALUES(?, ?, ?, ?, ?, 'verification', 'test-agent', ?, ?, ?)
        ON CONFLICT(draft_id, acceptance_id, kind) DO UPDATE SET
          execution_id = excluded.execution_id, result = excluded.result,
          evidence = excluded.evidence, updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), draft.draft_id, acceptance.id, draft.task_id, draft.story_index, executionId, result, evidence);
      }
  }
  function stableHash(value) {
      return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  function reviewExecutionInput(execution) {
      try {
          return JSON.parse(execution.input_json);
      }
      catch {
          throw new Error('当前 Review execution 的输入快照无法读取');
      }
  }
  function reviewExecutionForDraft(db, draft) {
      if (!draft.last_execution_id)
          throw new Error('Review 草稿缺少当前 execution');
      const execution = db.prepare(`
      SELECT execution_id, task_id, story_index, pipeline, input_json
      FROM execution_attempts WHERE execution_id = ?
    `).get(draft.last_execution_id);
      if (!execution)
          throw new Error('Review 草稿的当前 execution 不存在');
      return execution;
  }
  function reviewTaskHeader(db, taskId) {
      const task = db.prepare(`
      SELECT title, agile_status, current_subagent, total_stories,
             closure_status, review_document_id, review_revision
      FROM tasks WHERE task_id = ?
    `).get(taskId);
      if (!task)
          throw new Error('当前需求不存在');
      return task;
  }
  function reviewMode(execution) {
      return execution.pipeline === 'feedback-report' ? 'report_correction' : 'closure';
  }
  function reviewResourceFingerprint(resource) {
      return stableHash({
          ref: resource.ref,
          kind: resource.kind,
          status: resource.status,
          revision: resource.revision ?? null,
          deliveryUnit: resource.deliveryUnit ?? null,
          content: resource.content,
      });
  }
  function isIndependentReviewTestEvidence(resource) {
      if (resource.kind !== 'execution')
          return false;
      const content = resource.content;
      return content?.agent === 'test-agent'
          && ['applied', 'completed'].includes(content.status || resource.status)
          && content.outcome === 'completed'
          && content.verdict === 'passed';
  }
  // A Review attempt is operational progress, never proof of the delivery it
  // is currently assessing. Its ID/status necessarily changes after restart.
  function reviewExecutionRefs(db, draft) {
      return new Set(db.prepare("SELECT execution_id FROM execution_attempts WHERE task_id = ? AND agent = 'review-agent'")
          .all(draft.task_id).map(row => `EXEC:${row.execution_id}`));
  }
  function reviewEvidenceResources(db, draft, resources) {
      const own = reviewExecutionRefs(db, draft);
      return resources.filter(resource => !own.has(resource.ref)
          && !(resource.kind === 'execution' && resource.content?.agent === 'review-agent'));
  }
  function reviewClosureSubjects(db, draft) {
      const context = latestRequirementContextProjection(db, draft.task_id);
      if (!context?.intent.trim())
          throw new Error('普通结卡缺少已完成的 Requirement Context');
      const subjects = [{
              key: `REQUIREMENT_CONTEXT:${context.draftId}:intent`,
              kind: 'intent',
              content: context.intent.trim(),
              sourceRef: `REQUIREMENT_CONTEXT:${context.draftId}:intent`,
          }];
      for (const item of context.assertions.filter((assertion) => assertion.perspective === 'target')) {
          const ref = `REQUIREMENT_CONTEXT:${context.draftId}:assertion:${item.key}`;
          subjects.push({ key: ref, kind: 'target', content: item.statement, sourceRef: ref });
      }
      for (const item of context.impacts.filter((impact) => ['change', 'preserve', 'technical'].includes(impact.disposition))) {
          const ref = `REQUIREMENT_CONTEXT:${context.draftId}:impact:${item.key}`;
          subjects.push({
              key: ref, kind: 'impact', content: `[${item.disposition}] ${item.statement}\n原因：${item.rationale}`, sourceRef: ref,
          });
      }
      for (const acceptance of activeTaskAcceptances(db, draft.task_id)) {
          const ref = `ACCEPTANCE:${acceptance.acceptance_id}:r${acceptance.revision}`;
          subjects.push({
              key: ref,
              kind: 'acceptance',
              content: [
                  `Acceptance：${acceptance.acceptance_key}`,
                  `范围：${acceptance.scope_type}${acceptance.story_index ? ` · 交付单元 ${acceptance.story_index}` : ''}`,
                  `承诺：${acceptance.statement}`,
                  `Oracle：${acceptance.oracle}`,
              ].join('\n'),
              sourceRef: ref,
          });
      }
      const units = db.prepare(`
      SELECT s.story_index, s.unit_key, s.title, s.actor, s.trigger_condition,
             s.observable_outcome, s.acceptance, ss.spec_id, ss.revision
      FROM stories s
      LEFT JOIN story_specs ss ON ss.spec_id = (
        SELECT latest.spec_id FROM story_specs latest
        WHERE latest.task_id = s.task_id AND latest.story_index = s.story_index
          AND latest.status = 'resolved'
        ORDER BY latest.revision DESC LIMIT 1
      )
      WHERE s.task_id = ? ORDER BY s.story_index
    `).all(draft.task_id);
      for (const unit of units) {
          if (!unit.unit_key || !unit.actor || !unit.trigger_condition || !unit.observable_outcome || !unit.acceptance) {
              throw new Error(`交付单元 ${unit.story_index} 契约不完整`);
          }
          if (!unit.spec_id || !unit.revision)
              throw new Error(`交付单元 ${unit.story_index} 缺少已收敛的 Delivery Spec`);
          subjects.push({
              key: `DELIVERY_UNIT:${draft.task_id}:${unit.story_index}`,
              kind: 'delivery_unit',
              content: [
                  `交付单元 ${unit.story_index}：${unit.title}`,
                  `稳定 key：${unit.unit_key}`,
                  `参与者：${unit.actor}`,
                  `触发条件：${unit.trigger_condition}`,
                  `可观察结果：${unit.observable_outcome}`,
                  `验收语义：${unit.acceptance}`,
              ].join('\n'),
              contractRef: `SPEC:${unit.spec_id}:r${unit.revision}`,
              storyIndex: String(unit.story_index),
          });
      }
      const feedbackGroups = db.prepare(`
      SELECT fg.group_id, fg.title, fg.reason, fg.acceptance_json
      FROM feedback_groups fg
      JOIN feedback_batches fb ON fb.batch_id = fg.batch_id
      WHERE fb.task_id = ? AND fb.status = 'completed' AND fg.status = 'completed'
        AND fg.work_type IN ('bug', 'behavior_change', 'scope_addition', 'technical_change')
      ORDER BY fb.created_at, fg.group_order, fg.created_at
    `).all(draft.task_id);
      for (const group of feedbackGroups) {
          const acceptance = JSON.parse(group.acceptance_json);
          if (!Array.isArray(acceptance) || acceptance.some((item) => typeof item !== 'string' || !item.trim())) {
              throw new Error(`反馈工作组 ${group.group_id} 的验收语义无效`);
          }
          acceptance.forEach((item, index) => subjects.push({
              key: `FEEDBACK_GROUP:${group.group_id}:acceptance:${index + 1}`,
              kind: 'feedback_acceptance',
              content: `${group.title || group.reason}：${String(item).trim()}`,
              sourceRef: `FEEDBACK_GROUP:${group.group_id}`,
          }));
      }
      return subjects;
  }
  function reviewCorrectionSubjects(db, draft, execution) {
      const groupId = reviewExecutionInput(execution).delegation?.feedbackGroupId;
      if (!groupId)
          throw new Error('报告更正缺少反馈工作组');
      const group = db.prepare(`
      SELECT fg.group_id, fg.title, fg.reason, fg.acceptance_json
      FROM feedback_groups fg
      JOIN feedback_batches fb ON fb.batch_id = fg.batch_id
      WHERE fg.group_id = ? AND fb.task_id = ? AND fg.work_type = 'report_correction'
    `).get(groupId, draft.task_id);
      if (!group)
          throw new Error('报告更正关联的反馈工作组不存在或类型不正确');
      const acceptance = JSON.parse(group.acceptance_json);
      if (!Array.isArray(acceptance) || acceptance.some((item) => typeof item !== 'string' || !item.trim())) {
          throw new Error('报告更正工作组的验收语义无效');
      }
      return [{
              key: `FEEDBACK_GROUP:${group.group_id}:report_correction`,
              kind: 'feedback_acceptance',
              content: [
                  `报告更正：${group.title || group.reason}`,
                  `原因：${group.reason}`,
                  ...acceptance.map((item, index) => `${index + 1}. ${String(item).trim()}`),
              ].join('\n'),
              sourceRef: `FEEDBACK_GROUP:${group.group_id}`,
          }];
  }
  function assertReviewExecutionCurrent(db, draft, execution) {
      const task = reviewTaskHeader(db, draft.task_id);
      const input = reviewExecutionInput(execution).delegation || {};
      const mode = reviewMode(execution);
      if (mode === 'closure') {
          if (task.agile_status !== 'in review' || task.current_subagent !== 'review-agent' || task.closure_status !== 'none') {
              throw new Error('需求已离开普通结卡状态，请结束本轮并等待重新派发');
          }
          if (input.totalStories !== undefined && input.totalStories !== task.total_stories) {
              throw new Error('交付单元数量已变化，当前 Review execution 已过期，请重新派发');
          }
          if (input.reviewRevision !== undefined && input.reviewRevision !== task.review_revision) {
              throw new Error('结卡报告版本已变化，当前 Review execution 已过期，请重新派发');
          }
      }
      else {
          if (task.agile_status !== 'in feedback')
              throw new Error('需求已离开报告更正状态，请结束本轮并等待重新派发');
          if (!input.reviewDocumentId || input.reviewDocumentId !== task.review_document_id
              || input.reviewRevision !== task.review_revision) {
              throw new Error('结卡报告基线已变化，当前报告更正 execution 已过期，请重新派发');
          }
      }
      return task;
  }
  function insertYamlArtifact(db, draftId, artifactId, blockId, itemKey, value, ordinal) {
      db.prepare(`
      INSERT INTO command_chain_artifact_blocks(
        draft_id, artifact_id, block_id, item_key, content_format, content, ordinal
      ) VALUES(?, ?, ?, ?, 'yaml', ?, ?)
    `).run(draftId, artifactId, blockId, itemKey, stringify(value).trim(), ordinal);
  }
  function insertReviewArtifact(db, draftId, blockId, itemKey, value, ordinal) {
      insertYamlArtifact(db, draftId, 'review', blockId, itemKey, value, ordinal);
  }
  function cloneReviewReportBaseline(db, draft, documentId) {
      const source = db.prepare(`
      SELECT awd.draft_id
      FROM agent_work_drafts awd
      JOIN agent_results result ON result.execution_id = awd.terminal_execution_id
        AND result.agent = 'review-agent' AND result.application_status = 'applied'
        AND result.effect_outcome = 'advanced'
      JOIN documents baseline ON baseline.document_id = ? AND baseline.task_id = awd.task_id
        AND json_extract(result.result_json, '$.artifact.content') = loopwork_read_document(loopwork_read_payload(baseline.content))
      WHERE awd.task_id = ? AND awd.command_chain_id = 'review'
        AND awd.status = 'submitted' AND awd.terminal_action = 'complete'
        AND EXISTS (
          SELECT 1 FROM command_chain_artifact_blocks block
          WHERE block.draft_id = awd.draft_id AND block.artifact_id = 'review'
            AND block.block_id = 'report-sections'
        )
      ORDER BY awd.submitted_at DESC, awd.draft_version DESC LIMIT 1
    `).get(documentId, draft.task_id);
      if (!source)
          throw new Error('报告更正缺少可继承的结构化结卡报告基线');
      db.prepare(`
      INSERT INTO command_chain_artifact_blocks(
        draft_id, artifact_id, block_id, item_key, content_format, content, ordinal, updated_at
      )
      SELECT ?, artifact_id, block_id, item_key, content_format, content, ordinal, updated_at
      FROM command_chain_artifact_blocks
      WHERE draft_id = ? AND artifact_id = 'review' AND block_id = 'report-sections'
    `).run(draft.draft_id, source.draft_id);
  }
  function initializeReviewInputs(db, execution, draft) {
      const task = assertReviewExecutionCurrent(db, draft, execution);
      const mode = reviewMode(execution);
      const input = reviewExecutionInput(execution);
      const resources = reviewEvidenceResources(db, draft, input.contextSnapshot?.resources || []);
      const subjects = mode === 'closure'
          ? reviewClosureSubjects(db, draft)
          : reviewCorrectionSubjects(db, draft, execution);
      const visibleRefs = new Set(resources.map((resource) => resource.ref));
      const missingContracts = subjects.flatMap((subject) => subject.contractRef && !visibleRefs.has(subject.contractRef) ? [subject.contractRef] : []);
      if (missingContracts.length) {
          throw new Error(`必需交付契约不在当前冻结 Context Snapshot 中：${missingContracts.join(', ')}。请重新派发`);
      }
      subjects.forEach((subject, index) => insertReviewArtifact(db, draft.draft_id, 'subjects', subject.key, {
          kind: subject.kind,
          content: subject.content,
          ...(subject.sourceRef ? { sourceRef: subject.sourceRef } : {}),
          ...(subject.contractRef ? { contractRef: subject.contractRef } : {}),
          ...(subject.storyIndex ? { storyIndex: subject.storyIndex } : {}),
      }, index + 1));
      resources.forEach((resource, index) => insertReviewArtifact(db, draft.draft_id, 'evidence-sources', resource.ref, {
          ref: resource.ref,
          kind: resource.kind,
          status: resource.status,
          revision: resource.revision === undefined || resource.revision === null ? 'none' : String(resource.revision),
          fingerprint: reviewResourceFingerprint(resource),
          independentTest: isIndependentReviewTestEvidence(resource) ? 'yes' : 'no',
      }, index + 1));
      insertReviewArtifact(db, draft.draft_id, 'meta', '', {
          mode,
          totalStories: String(task.total_stories),
          reviewRevision: String(task.review_revision),
          ...(task.review_document_id ? { reviewDocumentId: task.review_document_id } : {}),
      }, 1);
      if (mode === 'report_correction') {
          if (!task.review_document_id || task.review_revision < 1)
              throw new Error('报告更正缺少当前结卡报告基线');
          cloneReviewReportBaseline(db, draft, task.review_document_id);
      }
  }
  function feedbackExecutionContext(execution) {
      try {
          const parsed = JSON.parse(execution.input_json);
          return {
              batchId: parsed.delegation?.feedbackBatchId || null,
              groupId: parsed.delegation?.feedbackGroupId || null,
              commentId: parsed.delegation?.feedbackId || null,
              commentIds: parsed.delegation?.feedbackIds || [],
          };
      }
      catch {
          throw new Error('当前 Feedback execution 的输入快照无法读取');
      }
  }
  function initializeFeedbackInputs(db, execution, draft) {
      const context = feedbackExecutionContext(execution);
      if (draft.command_chain_id === 'feedback-triage') {
          if (!context.batchId)
              throw new Error('反馈分流缺少冻结批次');
          const commentIds = db.prepare(`
        SELECT comment_id FROM feedback_batch_comments WHERE batch_id = ? ORDER BY ordinal, comment_id
      `).all(context.batchId).map((row) => row.comment_id);
          const frozen = commentIds.length ? commentIds : context.commentIds;
          if (!frozen.length)
              throw new Error('反馈分流批次没有冻结评论');
          frozen.forEach((commentId, index) => insertYamlArtifact(db, draft.draft_id, 'feedback', 'inputs', commentId, { commentId }, index + 1));
          const task = db.prepare('SELECT total_stories FROM tasks WHERE task_id = ?').get(draft.task_id);
          insertYamlArtifact(db, draft.draft_id, 'feedback', 'meta', '', {
              batchId: context.batchId, totalStories: String(task.total_stories),
          }, 1);
          return;
      }
      if (!context.commentId || !context.groupId)
          throw new Error('反馈验证缺少目标评论或工作组');
      insertYamlArtifact(db, draft.draft_id, 'feedback', 'target', '', {
          commentId: context.commentId, groupId: context.groupId,
      }, 1);
  }
  /** 初始化阶段状态与本轮冻结输入；这里只建立草稿，不领取新任务。 */
  function initializeCommandChainDraft(db, execution, draft) {
      const definition = definitionForDraft(draft);
      if (definition.id === 'delivery-analysis')
          currentDeliveryUnit(db, execution.task_id, execution.story_index);
      if (definition.id === 'development')
          currentDeliverySpec(db, execution.task_id, execution.story_index);
      if (definition.id === 'verification')
          currentDeliverySpec(db, execution.task_id, execution.story_index);
      db.prepare(`
      INSERT INTO command_chain_drafts(
        draft_id, command_chain_id, definition_version, workflow_phase
      ) VALUES(?, ?, ?, ?)
    `).run(draft.draft_id, definition.id, definition.version, Object.keys(definition.phases)[0]);
      if (definition.id === 'delivery-plan')
          initializeDeliveryPlanInputs(db, execution, draft);
      if (definition.id === 'verification')
          initializeVerificationInputs(db, draft);
      if (definition.id === 'review')
          initializeReviewInputs(db, execution, draft);
      if (definition.id === 'feedback-triage' || definition.id === 'feedback-verify') {
          initializeFeedbackInputs(db, execution, draft);
      }
  }
  /** 跨 execution 继承有效事实；Dev 的检查和 Test 的独立证据按新轮次重置。 */
  function cloneCommandChainDraft(db, source, target) {
      db.prepare(`
      INSERT INTO command_chain_drafts(
        draft_id, command_chain_id, definition_version, workflow_phase
      )
      SELECT ?, command_chain_id, definition_version, workflow_phase
      FROM command_chain_drafts WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
      db.prepare(`
      INSERT INTO command_chain_checks(
        draft_id, check_key, command, command_hash, summary,
        source_execution_id, source_receipt_key, ordinal, updated_at
      )
      SELECT ?, check_key, command, command_hash, summary,
             source_execution_id, source_receipt_key, ordinal, updated_at
      FROM command_chain_checks WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
      db.prepare(`
      INSERT INTO command_chain_runtime_inputs(
        draft_id, request_key, title, question, why, recommendation, ordinal, updated_at
      )
      SELECT ?, request_key, title, question, why, recommendation, ordinal, updated_at
      FROM command_chain_runtime_inputs WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
      db.prepare(`
      INSERT INTO command_chain_artifact_blocks(
        draft_id, artifact_id, block_id, item_key, content_format, content, ordinal, updated_at
      )
      SELECT ?, artifact_id, block_id, item_key, content_format, content, ordinal, updated_at
      FROM command_chain_artifact_blocks
      WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
      db.prepare(`
      INSERT INTO command_chain_acceptance_items(
        draft_id, acceptance_key, statement, oracle, source, ordinal, updated_at
      )
      SELECT ?, acceptance_key, statement, oracle, source, ordinal, updated_at
      FROM command_chain_acceptance_items WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
      const assessments = db.prepare(`
      SELECT acceptance_id, task_id, story_index, kind, agent, execution_id, result, evidence
      FROM acceptance_assessments WHERE draft_id = ?
    `).all(source.draft_id);
      const insertAssessment = db.prepare(`
      INSERT INTO acceptance_assessments(
        assessment_id, draft_id, acceptance_id, task_id, story_index,
        kind, agent, execution_id, result, evidence
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
      for (const assessment of assessments) {
          insertAssessment.run(randomUUID(), target.draft_id, assessment.acceptance_id, assessment.task_id, assessment.story_index, assessment.kind, assessment.agent, assessment.execution_id, assessment.result, assessment.evidence);
      }
      db.prepare(`
      INSERT INTO command_chain_decisions(
        draft_id, tree_id, decision_key, content, status, selected_option_id,
        authority, decision_text, rationale, evidence, human_requested, ordinal, updated_at
      )
      SELECT ?, tree_id, decision_key, content, status, selected_option_id,
             authority, decision_text, rationale, evidence, human_requested, ordinal, updated_at
      FROM command_chain_decisions WHERE draft_id = ?
    `).run(target.draft_id, source.draft_id);
      const targetDefinition = definitionForDraft(target);
      // A submitted analysis is a completed business cycle, not a suspended
      // checkpoint. Keep its facts for revision, but require a fresh analysis
      // pass instead of allowing the old FINALIZE to republish unchanged work.
      if (target.command_chain_id === 'delivery-analysis' && source.status === 'submitted') {
          db.prepare(`UPDATE command_chain_drafts SET workflow_phase = ? WHERE draft_id = ?`)
              .run(Object.keys(targetDefinition.phases)[0], target.draft_id);
      }
      if (target.command_chain_id === 'development' && source.status !== 'waiting_for_answers') {
          db.prepare(`UPDATE command_chain_drafts SET workflow_phase = ? WHERE draft_id = ?`)
              .run(Object.keys(targetDefinition.phases)[0], target.draft_id);
          db.prepare(`DELETE FROM command_chain_checks WHERE draft_id = ?`).run(target.draft_id);
          db.prepare(`
        DELETE FROM command_chain_artifact_blocks
        WHERE draft_id = ? AND block_id IN ('code-review', 'recovery-resolutions')
      `).run(target.draft_id);
      }
      if (target.command_chain_id === 'verification') {
          const inputsPhase = phaseIdForBuiltin(targetDefinition, 'verification-inputs');
          const executePhase = phaseIdForBuiltin(targetDefinition, 'verification-execution');
          db.prepare(`DELETE FROM acceptance_assessments WHERE draft_id = ?`).run(target.draft_id);
          if (!verificationSourcesMatch(db, target)) {
              db.prepare(`DELETE FROM command_chain_artifact_blocks WHERE draft_id = ? AND artifact_id = 'verification'`)
                  .run(target.draft_id);
              db.prepare(`UPDATE command_chain_drafts SET workflow_phase = ? WHERE draft_id = ?`).run(inputsPhase, target.draft_id);
              initializeVerificationInputs(db, target);
          }
          else if (source.status !== 'waiting_for_answers') {
              db.prepare(`UPDATE command_chain_drafts SET workflow_phase = ? WHERE draft_id = ?`).run(executePhase, target.draft_id);
              db.prepare(`
          DELETE FROM command_chain_artifact_blocks
          WHERE draft_id = ? AND artifact_id = 'verification' AND block_id IN ('results', 'evidence-review')
        `).run(target.draft_id);
          }
      }
      if (target.command_chain_id === 'review') {
          const inputsPhase = phaseIdForBuiltin(targetDefinition, 'review-inputs');
          db.prepare(`DELETE FROM command_chain_artifact_blocks WHERE draft_id = ? AND artifact_id = 'review'`)
              .run(target.draft_id);
          db.prepare(`UPDATE command_chain_drafts SET workflow_phase = ? WHERE draft_id = ?`).run(inputsPhase, target.draft_id);
          initializeReviewInputs(db, reviewExecutionForDraft(db, target), target);
      }
  }
  function parseObject(content, label) {
      let value;
      try {
          value = parse(content);
      }
      catch (error) {
          throw new Error(`${label} 不是有效 YAML：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error(`${label} 必须是 YAML 对象`);
      return value;
  }
  function displayValue(value) {
      if (value === undefined)
          return '(missing)';
      if (value === null)
          return 'null';
      const rendered = typeof value === 'string' ? value : stringify(value).trim();
      return rendered.length > 240 ? `${rendered.slice(0, 240)}…` : rendered;
  }
  function validationFailure(label, issues, options = {}) {
      throw new AgentCommandValidationError([
          `${label} 校验未通过，共 ${issues.length} 项；请一次性修正后重试`,
          ...issues.map((issue) => `- ${issue.path}: ${issue.message}${issue.expected ? `（允许/期望：${issue.expected}）` : ''}`),
      ].join('\n'), issues, options);
  }
  /** 校验结构化产物字段，避免把不完整或多余字段静默写成有效证据。 */
  function validateBlockContent(definition, content, label, identity) {
      if (definition.format !== 'yaml')
          return bounded(content, label);
      const schemaCommand = identity ? `schema show --artifact ${identity.artifactId} --block ${identity.blockId}` : undefined;
      const templateCommand = identity ? `artifact template --artifact ${identity.artifactId} --block ${identity.blockId}` : undefined;
      let value;
      try {
          value = parseObject(content, label);
      }
      catch (error) {
          validationFailure(label, [{
                  code: 'invalid_yaml', path: label,
                  message: error instanceof Error ? error.message : String(error),
                  expected: 'YAML object', received: content.slice(0, 240),
              }], { schemaCommand, templateCommand });
      }
      const issues = [];
      for (const name of Object.keys(value).filter((candidate) => !definition.fields[candidate])) {
          issues.push({
              code: 'schema_undeclared_field', path: `${label}.${name}`,
              message: '字段未在当前命令链 Schema 中声明',
              expected: Object.keys(definition.fields).join(', ') || '(no fields)', received: displayValue(value[name]),
          });
      }
      for (const [name, field] of Object.entries(definition.fields)) {
          const input = value[name];
          if (field.required && (input === undefined || input === null || input === '')) {
              issues.push({
                  code: 'schema_required', path: `${label}.${name}`, message: '必填字段缺失或为空',
                  expected: field.type === 'enum' ? `enum(${field.values?.join(' | ')})` : field.type,
                  received: displayValue(input),
              });
              continue;
          }
          if (input === undefined || input === null)
              continue;
          if (field.type === 'string' && (typeof input !== 'string' || !input.trim())) {
              issues.push({ code: 'schema_type', path: `${label}.${name}`, message: '必须是非空字符串', expected: 'non-empty string', received: displayValue(input) });
          }
          if (field.type === 'enum') {
              const normalized = typeof input === 'string' ? input.trim().toLowerCase().replaceAll('-', '_') : '';
              if (normalized && field.values?.includes(normalized))
                  value[name] = normalized;
              else
                  issues.push({ code: 'schema_enum', path: `${label}.${name}`, message: '枚举值无效', expected: field.values?.join(' | '), received: displayValue(input) });
          }
          if (field.type === 'array' && (!Array.isArray(input) || input.length < (field.minItems || 0))) {
              issues.push({
                  code: 'schema_array', path: `${label}.${name}`, message: `必须是至少包含 ${field.minItems || 0} 项的数组`,
                  expected: `array(minItems=${field.minItems || 0})`, received: displayValue(input),
              });
          }
          if (field.type === 'array' && Array.isArray(input) && field.itemType) {
              input.forEach((item,index) => {
                  const valid=field.itemType === 'string' ? typeof item === 'string' && Boolean(item.trim())
                      : field.itemType === 'number' ? typeof item === 'number' && Number.isFinite(item)
                      : item !== null && typeof item === 'object' && !Array.isArray(item);
                  if (!valid) issues.push({code:'schema_array_item',path:`${label}.${name}[${index}]`,message:`数组项必须是 ${field.itemType}，不做有损字符串转换`,expected:field.itemType,received:displayValue(item)});
              });
          }
      }
      if (issues.length)
          validationFailure(label, issues, { schemaCommand, templateCommand });
      return stringify(value).trim();
  }
  function parseDecision(content, definition, treeId, key) {
      const label = `decision/${key}`;
      const schemaCommand = `schema decision --tree ${treeId}`;
      const templateCommand = `decision template --tree ${treeId}`;
      let value;
      try {
          value = parseObject(content, label);
      }
      catch (error) {
          validationFailure(label, [{
                  code: 'invalid_yaml', path: label,
                  message: error instanceof Error ? error.message : String(error),
                  expected: 'YAML object', received: content.slice(0, 240),
              }], { schemaCommand, templateCommand });
      }
      const issues = [];
      const readString = (source, name, path, max) => {
          const input = source[name];
          if (typeof input !== 'string' || !input.trim()) {
              issues.push({ code: 'schema_required', path, message: '必须是非空字符串', expected: 'non-empty string', received: displayValue(input) });
              return '';
          }
          if (input.length > max) {
              issues.push({ code: 'schema_length', path, message: `不能超过 ${max} 字符`, expected: `string(max=${max})`, received: `${input.length} chars` });
          }
          return input.slice(0, max);
      };
      const allowedRootFields = ['type', 'title', 'question', 'impact', 'options', 'recommendation', 'dependencies'];
      for (const name of Object.keys(value).filter((candidate) => !allowedRootFields.includes(candidate))) {
          issues.push({ code: 'schema_undeclared_field', path: `${label}.${name}`, message: '字段未声明', expected: allowedRootFields.join(', '), received: displayValue(value[name]) });
      }
      const type = typeof value.type === 'string' ? value.type.trim().toLowerCase().replaceAll('-', '_') : '';
      if (!['business', 'technical'].includes(type)) {
          issues.push({ code: 'schema_enum', path: `${label}.type`, message: '枚举值无效', expected: 'business | technical', received: displayValue(value.type) });
      }
      const title = readString(value, 'title', `${label}.title`, 4000);
      const question = readString(value, 'question', `${label}.question`, 4000);
      const impact = readString(value, 'impact', `${label}.impact`, 4000);
      const optionsValue = Array.isArray(value.options) ? value.options : [];
      if (!Array.isArray(value.options)) {
          issues.push({ code: 'schema_type', path: `${label}.options`, message: '必须是数组', expected: `array(minItems=${definition.decisionTrees[treeId].minOptions})`, received: displayValue(value.options) });
      }
      else if (optionsValue.length < definition.decisionTrees[treeId].minOptions) {
          issues.push({ code: 'schema_array', path: `${label}.options`, message: `至少需要 ${definition.decisionTrees[treeId].minOptions} 个选项`, expected: `array(minItems=${definition.decisionTrees[treeId].minOptions})`, received: `${optionsValue.length} items` });
      }
      const options = optionsValue.map((input, index) => {
          const path = `${label}.options[${index}]`;
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
              issues.push({ code: 'schema_type', path, message: '必须是对象', expected: '{ id, label, consequence }', received: displayValue(input) });
              return { id: '', label: '', consequence: '' };
          }
          const option = input;
          const allowed = ['id', 'label', 'consequence'];
          for (const name of Object.keys(option).filter((candidate) => !allowed.includes(candidate))) {
              issues.push({ code: 'schema_undeclared_field', path: `${path}.${name}`, message: '字段未声明', expected: allowed.join(', '), received: displayValue(option[name]) });
          }
          return {
              id: readString(option, 'id', `${path}.id`, 100),
              label: readString(option, 'label', `${path}.label`, 240),
              consequence: readString(option, 'consequence', `${path}.consequence`, 1000),
          };
      });
      const populatedOptionIds = options.map((option) => option.id).filter(Boolean);
      if (new Set(populatedOptionIds).size !== populatedOptionIds.length) {
          issues.push({ code: 'schema_unique', path: `${label}.options[].id`, message: 'option id 不能重复', expected: 'unique ids', received: populatedOptionIds.join(', ') });
      }
      const recommendationValue = value.recommendation;
      const recommendation = recommendationValue && typeof recommendationValue === 'object' && !Array.isArray(recommendationValue)
          ? recommendationValue
          : {};
      if (recommendation !== recommendationValue) {
          issues.push({ code: 'schema_type', path: `${label}.recommendation`, message: '必须是对象', expected: '{ option, reason, authority }', received: displayValue(recommendationValue) });
      }
      const allowedRecommendationFields = ['option', 'reason', 'authority'];
      for (const name of Object.keys(recommendation).filter((candidate) => !allowedRecommendationFields.includes(candidate))) {
          issues.push({ code: 'schema_undeclared_field', path: `${label}.recommendation.${name}`, message: '字段未声明', expected: allowedRecommendationFields.join(', '), received: displayValue(recommendation[name]) });
      }
      const recommendationOption = readString(recommendation, 'option', `${label}.recommendation.option`, 100);
      const recommendationReason = readString(recommendation, 'reason', `${label}.recommendation.reason`, 4000);
      const authority = readString(recommendation, 'authority', `${label}.recommendation.authority`, 100)
          .trim().toLowerCase().replaceAll('-', '_');
      if (authority && !definition.decisionTrees[treeId].recommendationAuthorities.includes(authority)) {
          issues.push({
              code: 'decision_authority_invalid', path: `${label}.recommendation.authority`, message: '建议决定权无效',
              expected: definition.decisionTrees[treeId].recommendationAuthorities.join(' | '), received: authority,
          });
      }
      const dependenciesValue = value.dependencies ?? [];
      if (!Array.isArray(dependenciesValue)) {
          issues.push({ code: 'schema_type', path: `${label}.dependencies`, message: '必须是数组', expected: 'array', received: displayValue(dependenciesValue) });
      }
      const dependencies = (Array.isArray(dependenciesValue) ? dependenciesValue : []).map((input, index) => {
          const path = `${label}.dependencies[${index}]`;
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
              issues.push({ code: 'schema_type', path, message: '必须是对象', expected: '{ decision, option }', received: displayValue(input) });
              return { decision: '', option: '' };
          }
          const dependency = input;
          const allowed = ['decision', 'option'];
          for (const name of Object.keys(dependency).filter((candidate) => !allowed.includes(candidate))) {
              issues.push({ code: 'schema_undeclared_field', path: `${path}.${name}`, message: '字段未声明', expected: allowed.join(', '), received: displayValue(dependency[name]) });
          }
          return {
              decision: readString(dependency, 'decision', `${path}.decision`, 240),
              option: readString(dependency, 'option', `${path}.option`, 100),
          };
      });
      if (recommendationOption && populatedOptionIds.length && !populatedOptionIds.includes(recommendationOption)) {
          issues.push({ code: 'decision_option_missing', path: `${label}.recommendation.option`, message: '推荐选项必须引用 options 中存在的 id', expected: populatedOptionIds.join(' | '), received: recommendationOption });
      }
      if (issues.length)
          validationFailure(label, issues, { schemaCommand, templateCommand });
      return {
          type: type, title, question, impact, options,
          recommendation: { option: recommendationOption, reason: recommendationReason, authority },
          dependencies,
      };
  }
  /** 按当前草稿链 ID 读取同一工作目录的实现，不能切换到其他角色。 */
  function definitionForDraft(draft) {
      if (!draft.command_chain_id)
          throw new Error('未知命令链：(empty)');
      return loadCommandChainDefinition(draft.command_chain_id);
  }
  function phaseIdForBuiltin(definition, builtin) {
      const match = Object.entries(definition.phases).find(([, phase]) => phase.builtin === builtin);
      if (!match)
          throw new Error(`命令链 ${definition.id} 缺少内置 Phase ${builtin}`);
      return match[0];
  }
  function commandAllowed(definition, phase, command) {
      const operation = command.split(' ').slice(0, 2).join(' ');
      return definition.phases[phase].commands.some((candidate) => candidate.startsWith(operation));
  }
  function assertViewed(draft, executionId) {
      if (draft.status_viewed_execution_id !== executionId)
          throw new Error('本次启动尚未查看草稿状态。必须先执行 status');
      if (draft.status !== 'editing')
          throw new Error(`当前草稿状态为 ${draft.status}，不能继续编辑`);
  }
  function decodedArtifacts(rows) {
      return rows.map((row) => ({
          ...row,
          value: row.content_format === 'yaml' ? parseObject(row.content, `${row.block_id}/${row.item_key || 'singleton'}`) : row.content,
      }));
  }
  function decodedDecisions(rows, definition) {
      return rows.map((row) => ({ ...row, value: parseDecision(row.content, definition, row.tree_id, row.decision_key) }));
  }
  function requirementContextProjection(draftId, artifacts, acceptances) {
      const one = (blockId) => artifacts.find((artifact) => artifact.block_id === blockId);
      const many = (blockId) => artifacts.filter((artifact) => artifact.block_id === blockId);
      return {
          draftId,
          intent: String(one('intent')?.value || ''),
          assertions: many('assertions').map((artifact) => {
              const value = artifact.value;
              return {
                  key: artifact.item_key,
                  perspective: value.perspective,
                  statement: value.statement,
                  evidence: value.evidence,
                  source: value.source,
                  ...(value.decision ? { decision: value.decision } : {}),
              };
          }),
          changeSummary: String(one('change-summary')?.value || ''),
          impacts: many('impacts').map((artifact) => {
              const value = artifact.value;
              return {
                  key: artifact.item_key,
                  statement: value.statement,
                  disposition: value.disposition,
                  rationale: value.rationale,
                  source: value.source,
                  ...(value.decision ? { decision: value.decision } : {}),
              };
          }),
          scope: many('scope').map((artifact) => {
              const value = artifact.value;
              return {
                  key: artifact.item_key,
                  direction: value.direction,
                  content: value.content,
              };
          }),
          constraints: many('constraints').map((artifact) => ({
              key: artifact.item_key,
              content: String(artifact.value.content || ''),
          })),
          acceptance: acceptances.map((acceptance) => ({
              key: acceptance.acceptance_key,
              content: acceptance.statement,
              oracle: acceptance.oracle,
              source: acceptance.source,
          })),
      };
  }
  function latestRequirementContextProjection(db, taskId) {
      const draft = db.prepare(`
      SELECT draft_id
      FROM agent_work_drafts
      WHERE task_id = ? AND command_chain_id = 'requirement-context'
        AND status = 'submitted' AND terminal_action = 'complete'
      ORDER BY submitted_at DESC, draft_version DESC
      LIMIT 1
    `).get(taskId);
      if (!draft)
          return null;
      return requirementContextProjection(draft.draft_id, decodedArtifacts(artifactRows(db, draft.draft_id)), acceptanceDraftItems(db, draft.draft_id));
  }
  function executionFeedbackGroupId(execution) {
      try {
          return JSON.parse(execution.input_json)
              .delegation?.feedbackGroupId || null;
      }
      catch {
          throw new Error('当前 execution 的输入快照无法读取');
      }
  }
  function deliveryPlanInputSources(db, execution) {
      if (execution.pipeline === 'feedback-split') {
          const groupId = executionFeedbackGroupId(execution);
          if (!groupId)
              throw new Error('反馈交付规划缺少反馈工作组');
          const group = db.prepare(`
        SELECT group_id, group_key, title, reason, acceptance_json
        FROM feedback_groups WHERE group_id = ?
      `).get(groupId);
          if (!group)
              throw new Error('反馈交付规划关联的工作组不存在');
          const acceptance = JSON.parse(group.acceptance_json);
          if (!Array.isArray(acceptance)
              || acceptance.some((item) => typeof item !== 'string' || !item.trim())) {
              throw new Error('反馈工作组验收要求格式无效');
          }
          return [
              {
                  key: `change:feedback:${group.group_key}`,
                  kind: 'change',
                  content: group.title?.trim() ? `${group.title}：${group.reason}` : group.reason,
                  sourceRef: `FEEDBACK_GROUP:${group.group_id}`,
              },
              ...acceptance.map((item, index) => ({
                  key: `acceptance:feedback:${group.group_key}:${index + 1}`,
                  kind: 'acceptance',
                  content: String(item).trim(),
                  sourceRef: `FEEDBACK_GROUP:${group.group_id}`,
              })),
          ];
      }
      const context = latestRequirementContextProjection(db, execution.task_id);
      if (!context)
          throw new Error('交付规划缺少已完成的业务变化上下文');
      const unresolved = context.impacts.filter((item) => item.disposition === 'needs_decision');
      if (unresolved.length) {
          throw new Error(`业务变化上下文仍有待决影响：${unresolved.map((item) => item.key).join(', ')}`);
      }
      const sources = [
          ...context.impacts
              .filter((impact) => impact.disposition !== 'needs_decision')
              .map((impact) => ({
              key: `impact:${impact.key}`,
              kind: impact.disposition,
              content: impact.statement,
              sourceRef: `REQUIREMENT_CONTEXT:${context.draftId}:impact:${impact.key}`,
          })),
          ...activeRequirementAcceptances(db, execution.task_id).map((item) => ({
              key: `acceptance:${item.acceptance_key}`,
              kind: 'acceptance',
              content: item.statement,
              sourceRef: `ACCEPTANCE:${item.acceptance_id}:r${item.revision}`,
          })),
      ];
      if (!sources.length)
          throw new Error('业务变化上下文没有可供交付规划消费的影响或验收语义');
      return sources;
  }
  function initializeDeliveryPlanInputs(db, execution, draft) {
      const insert = db.prepare(`
      INSERT INTO command_chain_artifact_blocks(
        draft_id, artifact_id, block_id, item_key, content_format, content, ordinal
      ) VALUES(?, 'delivery-plan', 'sources', ?, 'yaml', ?, ?)
    `);
      for (const [index, source] of deliveryPlanInputSources(db, execution).entries()) {
          insert.run(draft.draft_id, source.key, stringify({ kind: source.kind, content: source.content, sourceRef: source.sourceRef }).trim(), index + 1);
      }
  }
  function deliveryPlanState(artifacts) {
      const sources = artifacts
          .filter((artifact) => artifact.artifact_id === 'delivery-plan' && artifact.block_id === 'sources')
          .map((artifact) => {
          const value = artifact.value;
          return {
              key: artifact.item_key,
              kind: value.kind,
              content: String(value.content || ''),
              sourceRef: String(value.sourceRef || ''),
          };
      });
      const units = artifacts
          .filter((artifact) => artifact.artifact_id === 'delivery-plan' && artifact.block_id === 'units')
          .map((artifact) => {
          const value = artifact.value;
          return {
              key: artifact.item_key,
              title: String(value.title || ''),
              actor: String(value.actor || ''),
              trigger: String(value.trigger || ''),
              observableOutcome: String(value.observableOutcome || ''),
              acceptance: String(value.acceptance || ''),
              sourceRefs: Array.isArray(value.sourceRefs) ? value.sourceRefs.map(String) : [],
              dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.map(String) : [],
              ordinal: artifact.ordinal,
          };
      });
      const one = (blockId) => artifacts.find((artifact) => artifact.artifact_id === 'delivery-plan' && artifact.block_id === blockId);
      return {
          sources,
          units,
          rationale: String(one('rationale')?.value || ''),
          coverage: String(one('coverage')?.value || ''),
          ordering: String(one('ordering')?.value || ''),
      };
  }
  function deliveryPlanErrors(db, draft, artifacts) {
      const state = deliveryPlanState(artifacts);
      const errors = [];
      if (!state.sources.length)
          errors.push('交付计划缺少冻结规划输入');
      if (!state.rationale.trim())
          errors.push('缺少拆分依据');
      if (!state.units.length)
          errors.push('至少需要一个交付单元');
      if (state.units.length > 50)
          errors.push('单次交付计划最多包含 50 个交付单元');
      if (!state.coverage.trim())
          errors.push('缺少整体覆盖说明');
      if (state.units.length > 1 && !state.ordering.trim())
          errors.push('多个交付单元必须说明推荐顺序与依赖依据');
      const sourceByKey = new Map(state.sources.map((source) => [source.key, source]));
      const unitByKey = new Map(state.units.map((unit) => [unit.key, unit]));
      const duplicateTitles = state.units
          .filter((unit, index) => state.units.findIndex((candidate) => candidate.title === unit.title) !== index)
          .map((unit) => unit.title);
      if (duplicateTitles.length)
          errors.push(`交付单元标题不能重复：${[...new Set(duplicateTitles)].join('、')}`);
      const existingKeys = new Set(db.prepare(`
      SELECT unit_key FROM stories WHERE task_id = ? AND unit_key IS NOT NULL
    `).all(draft.task_id).map((row) => row.unit_key));
      const conflicts = state.units.filter((unit) => existingKeys.has(unit.key)).map((unit) => unit.key);
      if (conflicts.length)
          errors.push(`交付单元 key 已存在：${conflicts.join('、')}`);
      for (const unit of state.units) {
          const unknownSources = unit.sourceRefs.filter((key) => !sourceByKey.has(key));
          if (unknownSources.length)
              errors.push(`交付单元 ${unit.key} 引用了不存在的规划输入：${unknownSources.join('、')}`);
          const linked = unit.sourceRefs.map((key) => sourceByKey.get(key)).filter(Boolean);
          if (!linked.some((source) => source.kind === 'change' || source.kind === 'acceptance')) {
              errors.push(`交付单元 ${unit.key} 尚未承接业务变化或验收语义`);
          }
          if (new Set(unit.sourceRefs).size !== unit.sourceRefs.length)
              errors.push(`交付单元 ${unit.key} 的 sourceRefs 不能重复`);
          if (new Set(unit.dependsOn).size !== unit.dependsOn.length)
              errors.push(`交付单元 ${unit.key} 的 dependsOn 不能重复`);
          for (const dependency of unit.dependsOn) {
              const parent = unitByKey.get(dependency);
              if (!parent)
                  errors.push(`交付单元 ${unit.key} 依赖了不存在的单元 ${dependency}`);
              else if (parent.key === unit.key)
                  errors.push(`交付单元 ${unit.key} 不能依赖自己`);
              else if (parent.ordinal >= unit.ordinal)
                  errors.push(`交付单元 ${unit.key} 的前置 ${dependency} 必须排在它之前`);
          }
      }
      for (const source of state.sources) {
          if (!state.units.some((unit) => unit.sourceRefs.includes(source.key))) {
              errors.push(`冻结规划输入 ${source.key} 尚未由任何交付单元承接`);
          }
      }
      const visiting = new Set();
      const visited = new Set();
      const visit = (key) => {
          if (visiting.has(key))
              return true;
          if (visited.has(key))
              return false;
          visiting.add(key);
          for (const dependency of unitByKey.get(key)?.dependsOn || []) {
              if (unitByKey.has(dependency) && visit(dependency))
                  return true;
          }
          visiting.delete(key);
          visited.add(key);
          return false;
      };
      if (state.units.some((unit) => visit(unit.key)))
          errors.push('交付单元依赖不能存在循环');
      return errors;
  }
  function verificationState(artifacts) {
      const selected = artifacts.filter((artifact) => artifact.artifact_id === 'verification');
      const sources = selected.filter((artifact) => artifact.block_id === 'sources').map((artifact) => ({
          key: artifact.item_key,
          ...artifact.value,
      }));
      const scenarios = selected.filter((artifact) => artifact.block_id === 'scenarios').map((artifact) => {
          const value = artifact.value;
          return {
              key: artifact.item_key,
              channel: String(value.channel || ''),
              title: String(value.title || ''), setup: String(value.setup || ''), steps: String(value.steps || ''),
              expected: String(value.expected || ''),
              coverageRefs: Array.isArray(value.coverageRefs) ? value.coverageRefs.map(String) : [],
              ordinal: artifact.ordinal,
          };
      });
      const results = selected.filter((artifact) => artifact.block_id === 'results').map((artifact) => {
          const value = artifact.value;
          return {
              key: artifact.item_key,
              status: String(value.status || ''),
              failureKind: value.failureKind ? String(value.failureKind) : null,
              evidence: String(value.evidence || ''), actualBehavior: value.actualBehavior ? String(value.actualBehavior) : '',
          };
      });
      const review = selected.find((artifact) => artifact.block_id === 'evidence-review')?.value;
      return {
          sources, scenarios, results,
          review: review ? { summary: String(review.summary || ''), residualRisk: String(review.residualRisk || '') } : null,
      };
  }
  function verificationPlanErrors(artifacts) {
      const state = verificationState(artifacts);
      const errors = [];
      if (!state.sources.some((source) => source.kind === 'acceptance')) {
          errors.push('验证输入缺少 Acceptance');
      }
      if (!state.scenarios.length)
          errors.push('验证计划至少需要一个场景');
      const sourceKeys = new Set(state.sources.map((source) => source.key));
      for (const scenario of state.scenarios) {
          const unknown = scenario.coverageRefs.filter((key) => !sourceKeys.has(key));
          if (unknown.length)
              errors.push(`场景 ${scenario.key} 引用了不存在的验证输入：${unknown.join('、')}`);
          if (new Set(scenario.coverageRefs).size !== scenario.coverageRefs.length) {
              errors.push(`场景 ${scenario.key} 的 coverageRefs 不能重复`);
          }
      }
      for (const source of state.sources) {
          if (!state.scenarios.some((scenario) => scenario.coverageRefs.includes(source.key))) {
              errors.push(`冻结验证输入 ${source.key} 尚未被任何场景覆盖`);
          }
      }
      if (!state.scenarios.some((scenario) => scenario.channel === 'frontend'
          && scenario.coverageRefs.some((key) => state.sources.some((source) => source.kind === 'acceptance' && source.key === key)))) {
          errors.push('至少一项 Acceptance 必须由 frontend 场景覆盖');
      }
      return errors;
  }
  function verificationExecutionErrors(artifacts, inputs) {
      const state = verificationState(artifacts);
      const errors = verificationPlanErrors(artifacts);
      const scenarioKeys = new Set(state.scenarios.map((scenario) => scenario.key));
      const unknown = state.results.filter((result) => !scenarioKeys.has(result.key)).map((result) => result.key);
      if (unknown.length)
          errors.push(`验证结果引用了不存在的场景：${unknown.join('、')}。results 的 --key 必须与原场景完全相同，不添加 result: 前缀；用 artifact remove --artifact verification --block results --key <错误key> 删除孤立结果，再按原场景 key 登记。`);
      const missing = state.scenarios.filter((scenario) => !state.results.some((result) => result.key === scenario.key));
      if (missing.length)
          errors.push(`以下场景尚无验证结果：${missing.map((scenario) => scenario.key).join('、')}`);
      for (const result of state.results) {
          if (result.status === 'passed' && result.failureKind)
              errors.push(`通过结果 ${result.key} 不能声明 failureKind`);
          if (result.status === 'failed' && !['implementation', 'specification'].includes(result.failureKind || '')) {
              errors.push(`失败结果 ${result.key} 的 failureKind 必须是 implementation 或 specification`);
          }
          if (result.status === 'blocked' && !['environment', 'inconclusive'].includes(result.failureKind || '')) {
              errors.push(`阻塞结果 ${result.key} 的 failureKind 必须是 environment 或 inconclusive`);
          }
      }
      if (state.results.some((result) => result.status === 'blocked') && !inputs.some((input) => !input.answer)) {
          errors.push('存在 blocked 场景时必须登记未回答的 runtime input；获得回答后应重新执行并更新结果');
      }
      return errors;
  }
  function reviewState(artifacts) {
      const selected = artifacts.filter((artifact) => artifact.artifact_id === 'review');
      const many = (blockId) => selected.filter((artifact) => artifact.block_id === blockId);
      const one = (blockId) => selected.find((artifact) => artifact.block_id === blockId);
      const subjects = many('subjects').map((artifact) => ({
          key: artifact.item_key,
          ...artifact.value,
      }));
      const evidenceSources = many('evidence-sources').map((artifact) => {
          const value = artifact.value;
          return {
              key: artifact.item_key,
              ref: String(value.ref || ''),
              kind: String(value.kind || ''),
              status: String(value.status || ''),
              revision: String(value.revision || ''),
              fingerprint: String(value.fingerprint || ''),
              independentTest: value.independentTest === 'yes',
          };
      });
      const metaValue = one('meta')?.value;
      const reconciliations = many('reconciliations').map((artifact) => {
          const value = artifact.value;
          return {
              key: artifact.item_key,
              subjectRef: String(value.subjectRef || ''),
              result: String(value.result || ''),
              evidenceRefs: Array.isArray(value.evidenceRefs) ? value.evidenceRefs.map(String) : [],
          };
      });
      const gaps = many('gaps').map((artifact) => {
          const value = artifact.value;
          return {
              key: artifact.item_key,
              subjectRef: String(value.subjectRef || ''),
              kind: String(value.kind || ''),
              reason: String(value.reason || ''),
              boundary: String(value.boundary || ''),
          };
      });
      const assessmentValue = one('assessment')?.value;
      const sections = many('report-sections').map((artifact) => {
          const value = artifact.value;
          return { key: artifact.item_key, kind: String(value.kind || ''), content: String(value.content || '') };
      });
      const units = many('forward-units').map((artifact) => {
          const value = artifact.value;
          return {
              key: artifact.item_key,
              title: String(value.title || ''), actor: String(value.actor || ''), trigger: String(value.trigger || ''),
              observableOutcome: String(value.observableOutcome || ''), acceptance: String(value.acceptance || ''),
              gapKeys: Array.isArray(value.gapKeys) ? value.gapKeys.map(String) : [],
              dependsOn: Array.isArray(value.dependsOn) ? value.dependsOn.map(String) : [],
          };
      });
      return {
          subjects,
          evidenceSources,
          meta: metaValue ? {
              mode: String(metaValue.mode || ''),
              totalStories: String(metaValue.totalStories || ''),
              reviewRevision: String(metaValue.reviewRevision || ''),
              reviewDocumentId: metaValue.reviewDocumentId ? String(metaValue.reviewDocumentId) : '',
          } : null,
          reconciliations,
          gaps,
          assessment: assessmentValue ? {
              summary: String(assessmentValue.summary || ''),
              evidenceBoundary: String(assessmentValue.evidenceBoundary || ''),
              residualRisk: assessmentValue.residualRisk ? String(assessmentValue.residualRisk) : '',
          } : null,
          sections,
          units,
      };
  }
  function reviewInputErrors(db, draft, artifacts) {
      const state = reviewState(artifacts);
      const errors = [];
      let execution = null;
      try {
          execution = reviewExecutionForDraft(db, draft);
          const task = assertReviewExecutionCurrent(db, draft, execution);
          if (!state.meta)
              errors.push('Review 缺少冻结元数据');
          else {
              if (state.meta.mode !== reviewMode(execution))
                  errors.push('Review 冻结模式与当前 pipeline 不一致');
              if (state.meta.totalStories !== String(task.total_stories))
                  errors.push('Review 冻结的交付单元数量已过期');
              if (state.meta.reviewRevision !== String(task.review_revision))
                  errors.push('Review 冻结的报告版本已过期');
              if (state.meta.reviewDocumentId !== (task.review_document_id || ''))
                  errors.push('Review 冻结的报告文档已过期');
          }
          const currentResources = reviewEvidenceResources(db, draft, reviewExecutionInput(execution).contextSnapshot?.resources || []);
          // Older editing drafts may contain this attempt's control snapshot.
          // Preserve that history, but do not treat it as frozen delivery proof.
          const own = reviewExecutionRefs(db, draft);
          const frozenSources = state.evidenceSources.filter(source => !own.has(source.ref));
          const frozenByRef = new Map(frozenSources.map((source) => [source.ref, source]));
          for (const resource of currentResources) {
              const frozen = frozenByRef.get(resource.ref);
              if (!frozen)
                  errors.push(`当前 Context Snapshot 出现未冻结证据：${resource.ref}`);
              else if (frozen.fingerprint !== reviewResourceFingerprint(resource)) {
                  errors.push(`冻结证据版本或内容已变化：${resource.ref}`);
              }
          }
          for (const frozen of frozenSources) {
              if (!currentResources.some((resource) => resource.ref === frozen.ref)) {
                  errors.push(`冻结证据已不在当前 Context Snapshot：${frozen.ref}`);
              }
          }
          const expectedSubjects = reviewMode(execution) === 'closure'
              ? reviewClosureSubjects(db, draft)
              : reviewCorrectionSubjects(db, draft, execution);
          if (JSON.stringify(state.subjects) !== JSON.stringify(expectedSubjects)) {
              errors.push('Review 冻结对象与当前需求事实已不一致，请重新派发');
          }
      }
      catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
      }
      if (!state.subjects.length)
          errors.push('Review 没有可对账的冻结对象');
      if (!state.evidenceSources.length)
          errors.push('Review 没有冻结证据来源');
      return [...new Set(errors)];
  }
  function reviewReconciliationErrors(artifacts) {
      const state = reviewState(artifacts);
      const errors = [];
      const subjectKeys = new Set(state.subjects.map((subject) => subject.key));
      const evidenceByRef = new Map(state.evidenceSources.map((source) => [source.ref, source]));
      const handled = new Map();
      for (const reconciliation of state.reconciliations) {
          if (!subjectKeys.has(reconciliation.subjectRef)) {
              errors.push(`对账 ${reconciliation.key} 引用了不存在的冻结对象：${reconciliation.subjectRef}`);
          }
          handled.set(reconciliation.subjectRef, [...(handled.get(reconciliation.subjectRef) || []), `reconciliation:${reconciliation.key}`]);
          if (new Set(reconciliation.evidenceRefs).size !== reconciliation.evidenceRefs.length) {
              errors.push(`对账 ${reconciliation.key} 的 evidenceRefs 不能重复`);
          }
          const unknown = reconciliation.evidenceRefs.filter((ref) => !evidenceByRef.has(ref));
          if (unknown.length)
              errors.push(`对账 ${reconciliation.key} 引用了未冻结证据：${unknown.join('、')}`);
          if (state.meta?.mode === 'closure'
              && !reconciliation.evidenceRefs.some((ref) => evidenceByRef.get(ref)?.independentTest)) {
              errors.push(`对账 ${reconciliation.key} 缺少独立 Test 通过证据`);
          }
      }
      for (const gap of state.gaps) {
          if (!subjectKeys.has(gap.subjectRef))
              errors.push(`缺口 ${gap.key} 引用了不存在的冻结对象：${gap.subjectRef}`);
          handled.set(gap.subjectRef, [...(handled.get(gap.subjectRef) || []), `gap:${gap.key}`]);
      }
      for (const subject of state.subjects) {
          const entries = handled.get(subject.key) || [];
          if (!entries.length)
              errors.push(`尚未对账：${subject.key}`);
          if (entries.length > 1)
              errors.push(`冻结对象 ${subject.key} 必须恰好选择一个 reconciliation 或 gap：${entries.join('、')}`);
      }
      if (state.meta?.mode === 'report_correction' && state.gaps.length) {
          errors.push('报告表达更正不能声明结卡缺口；该反馈必须重新分流');
      }
      return [...new Set(errors)];
  }
  function reviewAssessmentErrors(artifacts) {
      const assessment = reviewState(artifacts).assessment;
      if (!assessment?.summary.trim() || !assessment.evidenceBoundary.trim())
          return ['Review 缺少完整需求级结卡评估'];
      return [];
  }
  function hasReviewUnitDependencyCycle(units) {
      const byKey = new Map(units.map((unit) => [unit.key, unit]));
      const visiting = new Set();
      const visited = new Set();
      const visit = (key) => {
          if (visiting.has(key))
              return true;
          if (visited.has(key))
              return false;
          visiting.add(key);
          const cyclic = Boolean(byKey.get(key)?.dependsOn.some((dependency) => byKey.has(dependency) && visit(dependency)));
          visiting.delete(key);
          visited.add(key);
          return cyclic;
      };
      return units.some((unit) => visit(unit.key));
  }
  function reviewOutputErrors(artifacts) {
      const state = reviewState(artifacts);
      const errors = [];
      if (!state.gaps.length) {
          if (state.units.length)
              errors.push('没有结卡缺口时不能登记前向交付单元');
          const allowed = new Set(['outcome', 'scope', 'decisions', 'implementation', 'verification', 'deviations', 'risks', 'feedback']);
          for (const section of state.sections) {
              if (!allowed.has(section.key) || section.key !== section.kind) {
                  errors.push(`报告章节 ${section.key} 的 item key 必须与合法 kind 一致`);
              }
          }
          const required = ['outcome', 'scope', 'implementation', 'verification', 'risks'];
          const missing = required.filter((kind) => !state.sections.some((section) => section.kind === kind));
          if (missing.length)
              errors.push(`缺少结卡报告核心章节：${missing.join('、')}`);
      }
      else {
          if (state.sections.length)
              errors.push('存在结卡缺口时不能同时生成结卡报告章节');
          if (!state.units.length)
              errors.push('存在结卡缺口时至少需要一个完整前向交付单元');
          const gapKeys = new Set(state.gaps.map((gap) => gap.key));
          const covered = state.units.flatMap((unit) => unit.gapKeys);
          const missing = [...gapKeys].filter((key) => !covered.includes(key));
          if (missing.length)
              errors.push(`以下结卡缺口尚未被交付单元覆盖：${missing.join('、')}`);
          const unknown = covered.filter((key) => !gapKeys.has(key));
          if (unknown.length)
              errors.push(`前向交付单元引用了未知缺口：${[...new Set(unknown)].join('、')}`);
          const duplicates = covered.filter((key, index) => covered.indexOf(key) !== index);
          if (duplicates.length)
              errors.push(`每个结卡缺口只能由一个单元覆盖：${[...new Set(duplicates)].join('、')}`);
          const unitKeys = new Set(state.units.map((unit) => unit.key));
          for (const unit of state.units) {
              const unknownDependencies = unit.dependsOn.filter((key) => !unitKeys.has(key));
              if (unknownDependencies.length)
                  errors.push(`单元 ${unit.key} 引用了未知依赖：${unknownDependencies.join('、')}`);
              if (unit.dependsOn.includes(unit.key))
                  errors.push(`单元 ${unit.key} 不能依赖自身`);
          }
          if (hasReviewUnitDependencyCycle(state.units))
              errors.push('前向交付单元依赖不能形成环');
      }
      return [...new Set(errors)];
  }
  function feedbackState(artifacts) {
      const selected = artifacts.filter((artifact) => artifact.artifact_id === 'feedback');
      const many = (blockId) => selected.filter((artifact) => artifact.block_id === blockId);
      const one = (blockId) => selected.find((artifact) => artifact.block_id === blockId);
      const meta = one('meta')?.value;
      const target = one('target')?.value;
      const conclusion = one('conclusion')?.value;
      return {
          inputCommentIds: many('inputs').map((artifact) => String(artifact.value.commentId || '')),
          meta: meta ? { batchId: String(meta.batchId || ''), totalStories: Number(meta.totalStories || 0) } : null,
          target: target ? { commentId: String(target.commentId || ''), groupId: String(target.groupId || '') } : null,
          summary: String(one('summary')?.value || ''),
          groups: many('groups').map((artifact) => {
              const value = artifact.value;
              return {
                  key: artifact.item_key,
                  workType: String(value.workType || ''), title: value.title ? String(value.title) : '',
                  reason: String(value.reason || ''), response: value.response ? String(value.response) : '',
                  commentIds: Array.isArray(value.commentIds) ? value.commentIds.slice() : [],
                  affectedDeliveryUnits: Array.isArray(value.affectedDeliveryUnits) ? value.affectedDeliveryUnits.map(Number) : [],
                  acceptance: Array.isArray(value.acceptance) ? value.acceptance.slice() : [],
              };
          }),
          answerReview: String(one('answer-review')?.value || ''),
          evidence: many('evidence').map((artifact) => ({ key: artifact.item_key, content: String(artifact.value || '') })),
          conclusion: conclusion ? {
              verdict: String(conclusion.verdict || ''), reason: String(conclusion.reason || ''),
          } : null,
      };
  }
  function feedbackTriageInputErrors(db, draft, artifacts) {
      const state = feedbackState(artifacts);
      const execution = reviewExecutionForDraft(db, draft);
      const context = feedbackExecutionContext(execution);
      const errors = [];
      if (!context.batchId || state.meta?.batchId !== context.batchId)
          errors.push('反馈分流冻结 batch id 已变化');
      const expected = context.batchId
          ? db.prepare(`SELECT comment_id FROM feedback_batch_comments WHERE batch_id = ? ORDER BY ordinal, comment_id`)
              .all(context.batchId).map((row) => row.comment_id)
          : context.commentIds;
      if (JSON.stringify(state.inputCommentIds) !== JSON.stringify(expected))
          errors.push('反馈分流冻结评论集合已变化');
      const task = db.prepare('SELECT total_stories FROM tasks WHERE task_id = ?').get(draft.task_id);
      if (!task || state.meta?.totalStories !== task.total_stories)
          errors.push('反馈分流冻结的交付单元数量已变化');
      return errors;
  }
  function feedbackTriageCompleteErrors(artifacts) {
      const state = feedbackState(artifacts);
      const errors = [];
      if (!state.summary.trim())
          errors.push('缺少反馈处理摘要');
      if (!state.groups.length)
          errors.push('反馈分流至少需要一个工作组');
      const expected = new Set(state.inputCommentIds);
      const seen = new Set();
      for (const group of state.groups) {
          for (const commentId of group.commentIds) {
              if (!expected.has(commentId))
                  errors.push(`反馈分组 ${group.key} 引用了批次外评论：${commentId}`);
              if (seen.has(commentId))
                  errors.push(`反馈评论被多个分组重复引用：${commentId}`);
              seen.add(commentId);
          }
          if (['behavior_change', 'bug', 'scope_addition', 'technical_change', 'report_correction'].includes(group.workType)) {
              if (!group.title.trim())
                  errors.push(`反馈分组 ${group.key} 缺少标题`);
              if (!group.acceptance.length)
                  errors.push(`反馈分组 ${group.key} 缺少可验证验收条件`);
          }
          if (['reply', 'historical_correction'].includes(group.workType) && !group.response.trim()) {
              errors.push(`反馈分组 ${group.key} 缺少明确回复`);
          }
          const invalid = group.affectedDeliveryUnits.filter((index) => !Number.isInteger(index) || index < 1 || index > (state.meta?.totalStories || 0));
          if (invalid.length)
              errors.push(`反馈分组 ${group.key} 引用了不存在的交付单元：${invalid.join('、')}`);
      }
      const missing = state.inputCommentIds.filter((commentId) => !seen.has(commentId));
      if (missing.length)
          errors.push(`反馈分流遗漏评论：${missing.join('、')}`);
      return [...new Set(errors)];
  }
  function feedbackVerifyInputErrors(db, draft, artifacts) {
      const state = feedbackState(artifacts);
      const context = feedbackExecutionContext(reviewExecutionForDraft(db, draft));
      return state.target?.commentId === context.commentId && state.target?.groupId === context.groupId
          ? []
          : ['反馈验证目标已变化'];
  }
  function feedbackVerifyCompleteErrors(artifacts) {
      const state = feedbackState(artifacts);
      const errors = [];
      if (!state.summary.trim())
          errors.push('缺少反馈验证摘要');
      if (!state.evidence.length)
          errors.push('反馈验证至少需要一条独立证据');
      if (!state.conclusion?.reason.trim())
          errors.push('缺少反馈验证结论或理由');
      return errors;
  }
  function requirementContextErrors(db, draft, artifacts, decisions) {
      const context = requirementContextProjection(draft.draft_id, artifacts, acceptanceDraftItems(db, draft.draft_id));
      const errors = [];
      const reliable = context.assertions.filter((assertion) => assertion.evidence !== 'inferred' && assertion.evidence !== 'conflicted');
      const requirement = db.prepare('SELECT item_type FROM tasks WHERE task_id = ?')
          .get(draft.task_id);
      if (!context.intent.trim())
          errors.push('缺少业务意图');
      if (!reliable.some((assertion) => assertion.perspective === 'actual')) {
          errors.push('缺少可靠的 AS-IS Actual 陈述');
      }
      if (requirement?.item_type === 'bug'
          && !reliable.some((assertion) => assertion.perspective === 'expected')) {
          errors.push('Bug 需求缺少可靠的 Existing Expected 陈述');
      }
      if (!reliable.some((assertion) => assertion.perspective === 'target')) {
          errors.push('缺少可靠的 TO-BE Target 陈述');
      }
      if (context.assertions.some((assertion) => assertion.evidence === 'conflicted')) {
          errors.push('仍有未解决的证据冲突');
      }
      if (!context.changeSummary.trim())
          errors.push('缺少业务变化摘要');
      if (!context.impacts.length)
          errors.push('至少需要一项业务影响');
      if (context.impacts.some((impact) => impact.disposition === 'needs_decision')) {
          errors.push('仍有未收敛的 needs_decision 业务影响');
      }
      if (!context.scope.some((scope) => scope.direction === 'included')) {
          errors.push('至少需要一项 included 范围');
      }
      if (!context.acceptance.length)
          errors.push('至少需要一项需求级验收语义');
      const decisionKeys = new Set(decisions.map((decision) => decision.decision_key));
      for (const assertion of context.assertions) {
          if (assertion.decision && !decisionKeys.has(assertion.decision)) {
              errors.push(`业务陈述 ${assertion.key} 引用了不存在的决策 ${assertion.decision}`);
          }
      }
      for (const impact of context.impacts) {
          if (impact.decision && !decisionKeys.has(impact.decision)) {
              errors.push(`业务影响 ${impact.key} 引用了不存在的决策 ${impact.decision}`);
          }
          if (impact.disposition === 'needs_decision' && !impact.decision) {
              errors.push(`待决业务影响 ${impact.key} 必须关联 decision`);
          }
      }
      return errors;
  }
  function decisionAnswers(db, draft) {
      const definition = definitionForDraft(draft);
      const rows = db.prepare(`
      SELECT decision_key, answer, selected_option_id
      FROM questions
      WHERE task_id = ? AND story_index IS ? AND source_agent = ?
        AND decision_key IS NOT NULL AND status != 'superseded'
      ORDER BY created_at, question_id
    `).all(draft.task_id, draft.story_index, definition.agent);
      return new Map(rows.map((row) => [row.decision_key, row]));
  }
  function currentAnalysisDecisionMode(db, draft) {
      return analysisDecisionMode(requirementMetadataRows(db, draft.task_id));
  }
  function requirementMetadataRows(db, taskId) {
      return db.prepare(`
      SELECT metadata_key, metadata_value
      FROM requirement_metadata WHERE task_id = ?
      ORDER BY metadata_key
    `).all(taskId);
  }
  function resolvedPhaseInputs(db, draft, definition, inputIds) {
      const stored = new Map(requirementMetadataRows(db, draft.task_id)
          .map((row) => [row.metadata_key, row.metadata_value]));
      return inputIds.map((inputId) => {
          const input = definition.inputs[inputId];
          const storedValue = stored.get(input.metadataKey);
          const value = storedValue ?? input.defaultValue ?? null;
          const metadata = requirementMetadataDefinition(input.metadataKey);
          return {
              inputId,
              metadataKey: input.metadataKey,
              label: metadata?.label || input.metadataKey,
              required: input.required,
              value,
              displayValue: value === null ? null : requirementMetadataValueLabel(input.metadataKey, value),
              source: storedValue === undefined && input.defaultValue !== undefined ? 'default' : storedValue === undefined ? 'missing' : 'metadata',
          };
      });
  }
  function renderPhaseInputs(db, draft, definition, inputIds) {
      if (!inputIds.length)
          return [];
      return [
          '## PHASE INPUTS', '',
          ...resolvedPhaseInputs(db, draft, definition, inputIds).map((input) => (`- ${input.label} · \`${input.inputId}\` · \`${input.metadataKey}\` · ${input.required ? 'required' : 'optional'}：${input.displayValue ?? '未设置'}${input.source === 'default' ? '（默认值）' : ''}`)),
          '',
      ];
  }
  function renderBuiltInContexts(db, draft, contexts) {
      const lines = [];
      if (contexts.includes('acceptance-definitions')) {
          const items = acceptanceDraftItems(db, draft.draft_id);
          lines.push('## ACCEPTANCE DEFINITIONS', '', ...(items.length
              ? items.map((item) => `- ${item.acceptance_key}：${item.statement}\n  - Oracle: ${item.oracle}\n  - Source: ${item.source}`)
              : ['- None']), '');
      }
      if (contexts.includes('delivery-plan-inputs')) {
          const state = deliveryPlanState(decodedArtifacts(artifactRows(db, draft.draft_id)));
          lines.push('## FROZEN PLAN INPUTS', '', ...state.sources.map((source) => `- ${source.key} · ${source.kind}：${source.content}\n  - Source: ${source.sourceRef}`), '');
      }
      if (contexts.includes('verification-inputs')) {
          const state = verificationState(decodedArtifacts(artifactRows(db, draft.draft_id)));
          const covered = new Set(state.scenarios.flatMap((scenario) => scenario.coverageRefs));
          lines.push('## FROZEN VERIFICATION INPUTS', '', ...state.sources.map((source) => `- ${source.key} · ${source.kind} · ${covered.has(source.key) ? 'covered' : 'missing'}：${source.description}\n  - Oracle: ${source.oracle}\n  - Source: ${source.sourceRef}`), '');
      }
      if (contexts.includes('review-inputs')) {
          const state = reviewState(decodedArtifacts(artifactRows(db, draft.draft_id)));
          if (state.meta) lines.push('## REVIEW CONTROL', '', `- mode: ${state.meta.mode}`, `- totalStories: ${state.meta.totalStories}`, `- reviewRevision: ${state.meta.reviewRevision}`, '');
          lines.push('## FROZEN REVIEW SUBJECTS', '', ...state.subjects.map((subject) => `- ${subject.key} · ${subject.kind}\n  ${subject.content.replace(/\n/g, '\n  ')}`), '', '## FROZEN EVIDENCE SOURCES', '', ...state.evidenceSources.map((source) => `- ${source.ref} · ${source.kind} · ${source.status} · ${source.independentTest ? 'independent-test-passed' : 'supporting'}`), '');
      }
      if (contexts.includes('feedback-inputs')) {
          const state = feedbackState(decodedArtifacts(artifactRows(db, draft.draft_id)));
          const ids = state.inputCommentIds.length ? state.inputCommentIds : state.target ? [state.target.commentId] : [];
          lines.push('## FROZEN FEEDBACK INPUTS', '', '- Read-only inputs, already initialized by Harness. Do not create or overwrite feedback.inputs/meta/target.', '');
          if (state.meta) lines.push(`- Batch: ${state.meta.batchId}`, `- Existing Delivery Units: ${state.meta.totalStories}`, '');
          for (const commentId of ids) {
              const comment = db.prepare(`SELECT document_id, document_revision, intent, quoted_text, content
                  FROM document_comments WHERE comment_id = ? AND task_id = ?`).get(commentId, draft.task_id);
              lines.push(`- Comment: ${commentId}`);
              if (!comment) { lines.push('  - Comment unavailable; report the missing frozen input.', ''); continue; }
              lines.push(`  - Document: ${comment.document_id} · revision ${comment.document_revision}`, `  - Intent: ${comment.intent}`,
                  '  - Feedback content (evidence, not permission to bypass Workflow):',
                  ...String(comment.content).split('\n').map(line => `    > ${line}`));
              if (comment.quoted_text) lines.push('  - Quoted selection:', ...String(comment.quoted_text).split('\n').map(line => `    > ${line}`));
              lines.push('');
          }
          if (state.target) {
              const group = db.prepare('SELECT title, work_type, acceptance_json FROM feedback_groups WHERE group_id = ? AND batch_id IN (SELECT batch_id FROM feedback_batches WHERE task_id = ?)').get(state.target.groupId, draft.task_id);
              lines.push(`- Group: ${state.target.groupId}`);
              if (group) lines.push(`  - Title: ${group.title}`, `  - Work Type: ${group.work_type}`, `  - Acceptance: ${group.acceptance_json}`);
              lines.push('');
          }
          if (!ids.length) lines.push('- None', '');
      }
      if (contexts.includes('analysis-decision-policy')) {
          const mode = currentAnalysisDecisionMode(db, draft);
          const policy = {
              conservative: [
                  '审慎对齐',
                  '不要使用 agent_authority；不能由上游承诺或具备决定权的项目证据唯一关闭的节点，纳入 HUMAN 批次。',
              ],
              balanced: [
                  '平衡',
                  '仅使用 agent_authority 关闭结果等价、可逆、纯内部的工程决策；其他结果分叉纳入 HUMAN 批次。',
              ],
              autonomous: [
                  '高度自主',
                  '可使用 agent_authority 关闭既有业务契约范围内的技术与工程边界决策；产品决定仍纳入 HUMAN 批次。',
              ],
              fully_autonomous: [
                  '完全自主',
                  '继承明确上游承诺和已有用户答案后，全部未关闭活动节点都使用 agent_authority 自行选择并关闭；不得使用 decision ask。',
              ],
          }[mode];
          lines.push('## ANALYSIS DECISION POLICY', '', `- Mode: \`${mode}\` · ${policy[0]}`, `- Instruction: ${policy[1]}`, '- Fixed Boundary: 任何强度都不能覆盖明确的用户决定或冻结上游承诺、伪造项目事实、扩大当前需求与交付单元目标，或引入无关业务结果。', '- Scope: 本策略只在当前决策解决阶段生效。', '');
      }
      if (contexts.includes('development-evidence')) {
          const spec = currentDeliverySpec(db, draft.task_id, draft.story_index);
          const artifacts = artifactRows(db, draft.draft_id);
          const covered = new Set(acceptanceAssessments(db, draft.draft_id, 'implementation')
              .filter((assessment) => assessment.result === 'claimed')
              .map((assessment) => assessment.acceptance_key));
          const resolvedRecoveries = new Set(artifacts.filter((artifact) => artifact.block_id === 'recovery-resolutions').map((artifact) => artifact.item_key));
          lines.push('## DELIVERY SPEC CRITERIA', '', ...developmentCriteria(spec).map((criterion) => `- ${criterion.key} · ${covered.has(criterion.key) ? 'evidence recorded' : 'missing'} · ${criterion.description}\n  - Oracle: ${criterion.oracle}`), '');
          const recoveries = activeRecoveries(db, draft);
          lines.push('## ACTIVE RECOVERIES', '', ...(recoveries.length
              ? recoveries.map((recovery) => `- ${recovery.recovery_id} · ${resolvedRecoveries.has(recovery.recovery_id) ? 'resolution recorded' : 'missing'} · ${recovery.summary}`)
              : ['- None']), '', '## RUNTIME INPUTS', '', ...(runtimeInputRows(db, draft).length
              ? runtimeInputRows(db, draft).map((input) => `- ${input.request_key} · ${input.answer ? 'answered' : 'waiting'} · ${input.title}`)
              : ['- None']), '');
      }
      if (contexts.includes('captured-commands')) {
          const commands = capturedCommands(db, draft.status_viewed_execution_id || '');
          lines.push('## CAPTURED COMMANDS', '', ...(commands.length
              ? commands.map((command) => `- ${command.receiptKey} · ${command.passed ? 'success' : 'failed'} · ${command.command} · ${command.summary}`)
              : ['- None']), '', '## RECORDED CHECKS', '', ...(checkRows(db, draft.draft_id).length
              ? checkRows(db, draft.draft_id).map((check) => `- ${check.check_key} · receipt ${check.source_receipt_key} · ${check.command}`)
              : ['- None']), '', '## RUNTIME INPUTS', '', ...(runtimeInputRows(db, draft).length
              ? runtimeInputRows(db, draft).map((input) => `- ${input.request_key} · ${input.answer ? 'answered' : 'waiting'} · ${input.title}`)
              : ['- None']), '');
      }
      return lines;
  }
  function businessAnalysisCompleteErrors(draft, artifacts) {
      const definition = definitionForDraft(draft);
      const selected = (blockId) => artifacts.filter((artifact) => artifact.block_id === blockId);
      const has = (blockId) => selected(blockId).length > 0;
      const missing = (blockIds) => blockIds.filter((blockId) => !has(blockId));
      const errors = [];
      if (definition.id === 'idea-context') {
          const absent = missing(['problem', 'actors', 'goals', 'success']);
          if (absent.length)
              errors.push(`需求意图简报缺少核心 Block：${absent.join('、')}`);
          return errors;
      }
      if (definition.id === 'business-design') {
          const gaps = selected('upstream-gaps');
          const outputBlocks = ['summary', 'actors', 'scenarios', 'flows', 'rules', 'states', 'scope', 'success', 'dependencies'];
          if (gaps.length) {
              const conflicting = outputBlocks.filter(has);
              if (conflicting.length)
                  errors.push(`需求意图回流不能同时提交业务方案 Block：${conflicting.join('、')}`);
              return errors;
          }
          const absent = missing(['summary', 'actors', 'scenarios', 'flows', 'rules', 'scope', 'success']);
          if (absent.length)
              errors.push(`业务方案缺少核心 Block：${absent.join('、')}`);
          return errors;
      }
      if (definition.id === 'requirement-spec') {
          const gaps = selected('upstream-gaps');
          if (gaps.length) {
              const targets = new Set(gaps.map((gap) => String(gap.value.target || '')));
              if (targets.size !== 1)
                  errors.push('需求规格的全部上游缺口必须指向同一个职责目标');
              if (has('final'))
                  errors.push('存在上游缺口时不能同时提交最终需求规格');
              return errors;
          }
          const absent = missing(['draft', 'verification', 'final']);
          if (absent.length)
              errors.push(`需求规格正常推进分支缺少 Block：${absent.join('、')}`);
          return errors;
      }
      if (definition.id === 'spec-review') {
          const gaps = selected('gaps');
          if (gaps.length) {
              const targets = new Set(gaps.map((gap) => String(gap.value.target || '')));
              if (targets.size !== 1)
                  errors.push('规格审查的全部阻断缺口必须指向同一个职责目标');
              if (has('approved-specification'))
                  errors.push('存在阻断缺口时不能同时批准需求规格');
              if (!selected('findings').some((finding) => String(finding.value.verdict || '') === 'gap')) {
                  errors.push('规格审查声明了阻断缺口，但没有对应的 gap 检查发现');
              }
              return errors;
          }
          if (!has('approved-specification'))
              errors.push('规格审查无阻断缺口时必须登记完整批准规格');
          return errors;
      }
      return [`未知 Business Analysis 命令链：${definition.id}`];
  }
  /** 先执行共享结构/协议校验，再调用角色脚本 validate；所有错误合并去重。 */
  function validatorErrors(db, draft, names) {
      const definition = definitionForDraft(draft);
      const artifacts = decodedArtifacts(artifactRows(db, draft.draft_id));
      const decisions = decodedDecisions(decisionRows(db, draft.draft_id), definition);
      const errors = [];
      if (names.includes('delivery-unit')) {
          try {
              currentDeliveryUnit(db, draft.task_id, draft.story_index);
          }
          catch (error) {
              errors.push(error instanceof Error ? error.message : String(error));
          }
      }
      if (names.includes('acceptance-required') && !acceptanceDraftItems(db, draft.draft_id).length) {
          errors.push('至少需要定义一项 Acceptance');
      }
      if (names.includes('delivery-spec')) {
          try {
              currentDeliverySpec(db, draft.task_id, draft.story_index);
          }
          catch (error) {
              errors.push(error instanceof Error ? error.message : String(error));
          }
      }
      if (names.includes('artifact-schema')) {
          for (const row of artifactRows(db, draft.draft_id)) {
              const block = definition.artifacts[row.artifact_id]?.blocks[row.block_id];
              if (!block)
                  errors.push(`存在未声明的 Artifact Block：${row.artifact_id}/${row.block_id}`);
              else {
                  try {
                      validateBlockContent(block, row.content, `${row.artifact_id}/${row.block_id}/${row.item_key || 'singleton'}`);
                  }
                  catch (error) {
                      errors.push(error instanceof Error ? error.message : String(error));
                  }
              }
          }
      }
      for (const name of names.filter((validator) => validator.startsWith('artifact-required:'))) {
          const reference = name.slice('artifact-required:'.length);
          const [artifactId, blockId] = reference.split('.');
          if (!artifacts.some((row) => row.artifact_id === artifactId && row.block_id === blockId)) {
              errors.push(`缺少必需的 Artifact Block：${reference}`);
          }
      }
      for (const name of names.filter((validator) => validator.startsWith('metadata-required:'))) {
          const inputId = name.slice('metadata-required:'.length);
          const [input] = resolvedPhaseInputs(db, draft, definition, [inputId]);
          if (!input?.value?.trim())
              errors.push(`缺少必需的 Metadata Input：${inputId}`);
      }
      if (names.includes('impact-links')) {
          const impacts = artifacts.filter((row) => row.block_id === 'impacts');
          if (!impacts.length)
              errors.push('至少需要登记一项实际影响');
          const decisionKeys = new Set(decisions.map((decision) => decision.decision_key));
          for (const impact of impacts) {
              const value = impact.value;
              if (value.disposition === 'needs_decision' && !value.decision)
                  errors.push(`影响 ${impact.item_key} 必须关联 decision`);
              if (value.decision && !decisionKeys.has(String(value.decision)))
                  errors.push(`影响 ${impact.item_key} 关联了不存在的决策 ${value.decision}`);
          }
      }
      if (names.includes('decision-schema')) {
          for (const decision of decisions) {
              if (decision.value.options.length < definition.decisionTrees[decision.tree_id].minOptions) {
                  errors.push(`决策 ${decision.decision_key} 至少需要 ${definition.decisionTrees[decision.tree_id].minOptions} 个选项`);
              }
              if (!decision.value.options.some((option) => option.id === decision.value.recommendation.option)) {
                  errors.push(`决策 ${decision.decision_key} 的推荐选项不存在`);
              }
          }
      }
      if (names.includes('decision-graph')) {
          const byKey = new Map(decisions.map((decision) => [decision.decision_key, decision]));
          for (const decision of decisions) {
              for (const dependency of decision.value.dependencies) {
                  const parent = byKey.get(dependency.decision);
                  if (!parent)
                      errors.push(`决策 ${decision.decision_key} 依赖了不存在的决策 ${dependency.decision}`);
                  else if (!parent.value.options.some((option) => option.id === dependency.option))
                      errors.push(`决策 ${decision.decision_key} 的依赖选项不存在`);
              }
          }
          const visiting = new Set();
          const visited = new Set();
          const visit = (key) => {
              if (visiting.has(key))
                  return true;
              if (visited.has(key))
                  return false;
              visiting.add(key);
              const decision = byKey.get(key);
              const cyclic = Boolean(decision?.value.dependencies.some((dependency) => visit(dependency.decision)));
              visiting.delete(key);
              visited.add(key);
              return cyclic;
          };
          if (decisions.some((decision) => visit(decision.decision_key)))
              errors.push('决策树不能存在循环依赖');
      }
      if (names.includes('decision-resolution') || names.includes('decision-complete')) {
          const answers = decisionAnswers(db, draft);
          for (const decision of decisions) {
              if (decision.status === 'proposed')
                  errors.push(`决策 ${decision.decision_key} 尚未解决或加入 HUMAN 批次`);
              const answer = answers.get(decision.decision_key);
              if ((answer?.answer?.trim() || answer?.selected_option_id)
                  && (decision.status !== 'resolved' || decision.authority !== 'user')) {
                  errors.push(`已回答决策 ${decision.decision_key} 必须以 user 权限关闭`);
              }
              if (names.includes('decision-complete') && decision.status !== 'resolved')
                  errors.push(`决策 ${decision.decision_key} 尚未关闭`);
          }
          if (names.includes('decision-complete')) {
              for (const impact of artifacts.filter((row) => row.block_id === 'impacts')) {
                  if (impact.value.disposition === 'needs_decision')
                      errors.push(`影响 ${impact.item_key} 仍为 needs_decision`);
              }
          }
      }
      if (names.includes('delivery-contract')) {
          if (!artifacts.some((row) => row.block_id === 'summary'))
              errors.push('缺少交付分析 summary');
          if (!artifacts.some((row) => row.block_id === 'contract'))
              errors.push('缺少冻结交付 contract');
      }
      if (names.includes('runtime-input-complete') && runtimeInputRows(db, draft).some((input) => !input.answer)) {
          errors.push('仍有未回答的运行信息请求');
      }
      errors.push(...validateScript({ db, draft, names, artifacts, decisions, tools: scriptTools() }));
      return [...new Set(errors)];
  }
  function fieldContract(field) {
      const type = field.type === 'enum'
          ? `enum(${field.values?.join(' | ')})`
          : field.type === 'array'
              ? `array${field.itemType ? `<${field.itemType}>` : ''}(minItems=${field.minItems || 0})`
              : 'string';
      return `${type} · ${field.required ? 'required' : 'optional'}${field.label ? ` · ${field.label}` : ''}`;
  }
  function artifactSchemaLines(artifactId, blockId, block) {
      if (block.format !== 'yaml') {
          return [`- Schema: ${block.format} content`, `- Constraint: ${block.required ? 'required' : 'optional'} · ${block.cardinality}`];
      }
      const fields = Object.entries(block.fields);
      return [
          `- Schema: \`schema show --artifact ${artifactId} --block ${blockId}\``,
          `- Template: \`artifact template --artifact ${artifactId} --block ${blockId}\``,
          ...(fields.length
              ? fields.map(([name, field]) => `  - \`${name}\`: ${fieldContract(field)}`)
              : ['  - YAML object without declared fields']),
      ];
  }
  function artifactTemplate(block) {
      if (block.format !== 'yaml')
          return block.format === 'markdown' ? '# REPLACE_ME\n\nREPLACE_ME' : 'REPLACE_ME';
      // Optional fields are omitted, not filled with invalid empty strings or
      // invented reference keys. The full schema still documents them above.
      return stringify(Object.fromEntries(Object.entries(block.fields).filter(([, field]) => field.required).map(([name, field]) => {
          if (field.type === 'enum')
              return [name, field.values?.[0] || 'REPLACE_ME'];
          if (field.type === 'array')
              return [name, (field.minItems || 0) > 0 ? [field.itemType === 'number' ? 1 : field.itemType === 'object' ? {value:'REPLACE_ME'} : 'REPLACE_ME'] : []];
          return [name, field.required ? 'REPLACE_ME' : ''];
      }))).trim();
  }
  function decisionSchemaLines(definition, treeId) {
      const tree = definition.decisionTrees[treeId];
      if (!tree)
          throw new Error(`未声明 Decision Tree：${treeId}`);
      return [
          '- `type`: enum(business | technical) · required',
          '- `title`: string · required',
          '- `question`: string · required',
          '- `impact`: string · required',
          `- \`options\`: array(minItems=${tree.minOptions}) · required`,
          '  - `id`: string · required · unique',
          '  - `label`: string · required',
          '  - `consequence`: string · required',
          '- `recommendation`: object · required',
          '  - `option`: string · required · must reference options[].id',
          '  - `reason`: string · required',
          `  - \`authority\`: enum(${tree.recommendationAuthorities.join(' | ')}) · required`,
          '- `dependencies`: array · optional',
          '  - `decision`: string · required',
          '  - `option`: string · required',
      ];
  }
  function decisionTemplate(definition, treeId) {
      const tree = definition.decisionTrees[treeId];
      if (!tree)
          throw new Error(`未声明 Decision Tree：${treeId}`);
      const options = Array.from({ length: Math.max(2, tree.minOptions) }, (_, index) => ({
          id: `option-${index + 1}`, label: 'REPLACE_ME', consequence: 'REPLACE_ME',
      }));
      return stringify({
          type: 'business', title: 'REPLACE_ME', question: 'REPLACE_ME', impact: 'REPLACE_ME', options,
          recommendation: {
              option: options[0].id,
              reason: 'REPLACE_ME',
              authority: tree.recommendationAuthorities[0] || 'agent_authority',
          },
          dependencies: [],
      }).trim();
  }
  function commandInvocation(command) {
      const appRoot = process.env.LOOP_APP_ROOT?.trim() || '<Harness Command Root>';
      return `${loopAgentCommandPrefix(appRoot)} ${command}`;
  }
  // These are protocol templates from describe(), not executable Shell strings.
  // Keep <placeholder> tokens together; the Agent replaces them with real values.
  function workCommandExamples(command) {
      const args = command.match(/<[^>]*>|\S+/g) || [];
      return [
          `- Native loopwork tool: \`${JSON.stringify({ args })}\``,
          `  - CLI reference for maintainers: \`${commandInvocation(command)}\``,
      ];
  }
  function sampleFilePath(name, format) {
      // CLI samples use the environment variable so models never retype execution UUIDs.
      const directory = '$LOOP_AGENT_TMP_DIR';
      const extension = format === 'markdown' ? 'md' : format === 'text' ? 'txt' : 'yaml';
      return `${directory}/${name.replace(/[^a-z0-9._-]+/gi, '-')}.${extension}`;
  }
  function nativeInputSample(args, input = 'REPLACE_ME with the completed template text above') {
      return [
          `Preferred native loopwork call: replace input with ${typeof input === 'object' ? 'the completed JSON object' : 'the completed UTF-8 template text'}. The adapter handles the temporary file.`,
          '```json', JSON.stringify({ args, input }, null, 2), '```',
          'CLI equivalent for maintainers (Shell expands $LOOP_AGENT_TMP_DIR):', '',
      ];
  }
  function artifactUsageSample(artifactId, blockId, block) {
      const file = sampleFilePath(`${artifactId}-${blockId}`, block.format);
      const key = block.cardinality === 'many' ? ' --key <stable-key>' : '';
      const template = artifactTemplate(block);
      return [
          '#### Ready-to-use sample', '',
          'Use the native call below. Omit optional fields unless applicable; when present they must satisfy the schema.', '',
          ...nativeInputSample(['artifact', 'put', '--artifact', artifactId, '--block', blockId, ...(block.cardinality === 'many' ? ['--key', 'REPLACE_ME'] : []), '--content-file', '@input'], block.format === 'yaml' ? parse(template) : template),
          `- File: \`${file}\``, '',
          'For the CLI, write the same input as UTF-8 text (JSON for schema records) to that file.', '',
          '\`\`\`bash',
          commandInvocation(`artifact put --artifact ${artifactId} --block ${blockId}${key} --content-file ${JSON.stringify(file)}`),
          '\`\`\`',
      ];
  }
  function decisionUsageSample(definition, treeId) {
      const file = sampleFilePath(`${treeId}-decision`, 'yaml');
      return [
          '#### Ready-to-use sample', '',
          'Replace the sample values and choose authority according to the actual responsibility before submission.', '',
          ...nativeInputSample(['decision', 'put', '--tree', treeId, '--key', 'REPLACE_ME', '--content-file', '@input'], parse(decisionTemplate(definition, treeId))),
          `- File: \`${file}\``, '',
          'For the CLI, serialize the same input object as JSON into that file.', '',
          '\`\`\`bash',
          commandInvocation(`decision put --tree ${treeId} --key <stable-key> --content-file ${JSON.stringify(file)}`),
          '\`\`\`',
      ];
  }
  function acceptanceUsageSample() {
      const file = sampleFilePath('acceptance', 'yaml');
      return [
          '### Ready-to-use sample', '',
          'Replace the sample values before submission.', '',
          `- File: \`${file}\``, '',
          '\`\`\`yaml', stringify({
              statement: 'REPLACE_ME',
              oracle: 'REPLACE_ME',
              source: 'REPLACE_ME',
          }).trim(), '\`\`\`', '',
          ...nativeInputSample(['acceptance', 'put', '--key', 'REPLACE_ME', '--content-file', '@input']),
          '\`\`\`bash',
          commandInvocation(`acceptance put --key <stable-key> --content-file ${JSON.stringify(file)}`),
          '\`\`\`',
      ];
  }
  /** 投影当前唯一阶段的目标、可用命令和上下文；Prompt 应以该工作包为准。 */
  function renderWorkPacket(db, draft) {
      const definition = definitionForDraft(draft);
      const state = chainState(db, draft.draft_id);
      const artifacts = artifactRows(db, draft.draft_id);
      const decisions = decisionRows(db, draft.draft_id);
      const answers = decisionAnswers(db, draft);
      const phase = definition.phases[state.workflow_phase];
      if (!phase) throw new Error(`命令脚本缺少活动草稿阶段 ${state.workflow_phase}；请恢复该阶段后继续执行`);
      const phaseBlocks = phase.artifactBlocks.map(({ artifactId, blockId }) => ({
          artifactId,
          blockId,
          block: definition.artifacts[artifactId].blocks[blockId],
      }));
      const blockCounts = new Map();
      for (const artifact of artifacts)
          blockCounts.set(artifact.block_id, (blockCounts.get(artifact.block_id) || 0) + 1);
      return [
          '# NEXT WORK PACKET', '', `- Draft: v${draft.draft_version}`, `- Command Chain: ${definition.id}@${definition.version}`, `- Phase: ${state.workflow_phase}`,
          `- Agent Temp Directory: ${process.env.LOOP_AGENT_TMP_DIR || '$LOOP_AGENT_TMP_DIR'}`, '',
          '## PHASE', '', `${phase.title} · ${phase.type}`, '',
          '## INSTRUCTIONS', '', phase.instructions, '',
          '## ARTIFACTS', '',
          ...(phaseBlocks.length
              ? [
                  '以下 Artifact 必须通过本阶段的 WORK COMMANDS 写入，不能在 phase complete 中直接返回：', '',
                  ...phaseBlocks.flatMap(({ artifactId, blockId, block }) => [
                      `### ${block.title} · \`${artifactId}.${blockId}\``, '',
                      `- Shape: ${block.cardinality} · ${block.format} · ${block.required ? 'required' : 'optional'}`,
                      ...artifactSchemaLines(artifactId, blockId, block),
                      '',
                      ...artifactUsageSample(artifactId, blockId, block),
                      '',
                  ]),
              ]
              : ['- None']),
          ...(phase.workCommands.some((command) => command.startsWith('decision put'))
              ? [
                  '', '## DECISION SCHEMA', '',
                  ...Object.keys(definition.decisionTrees).flatMap((treeId) => [
                      `### \`${treeId}\``, '',
                      `- Schema: \`schema decision --tree ${treeId}\``,
                      `- Template: \`decision template --tree ${treeId}\``,
                      ...decisionSchemaLines(definition, treeId),
                      '',
                      ...decisionUsageSample(definition, treeId),
                      '',
                  ]),
              ]
              : []),
          ...(phase.workCommands.some((command) => command.startsWith('acceptance put'))
              ? [
                  '', '## ACCEPTANCE SCHEMA', '',
                  '- `statement`: string · required',
                  '- `oracle`: string · required',
                  '- `source`: string · required',
                  '',
                  ...acceptanceUsageSample(),
              ]
              : []),
          '',
          ...renderPhaseInputs(db, draft, definition, phase.inputs),
          ...renderBuiltInContexts(db, draft, phase.contexts),
          '## READ DRAFT CONTENT', '',
          'Read-only access to this execution\'s draft in any phase. Fetch only the records needed for the next step; original bodies are preserved.',
          ...workCommandExamples('artifact get --artifact <id> --block <id>'),
          ...workCommandExamples('acceptance get'),
          ...workCommandExamples('decision get --tree <id>'),
          'Add --key with an existing stable key to read one record.', '',
          '## WORK COMMANDS', '',
          ...(phase.workCommands.length
              ? phase.workCommands.flatMap(workCommandExamples)
              : ['- None']),
          '',
          '## COMPLETE', '', ...workCommandExamples(phase.completeCommand), '',
          '## REWIND', '', ...(phase.rewindCommand ? workCommandExamples(phase.rewindCommand) : ['- Not available from the initial phase']), '',
          '## CURRENT DRAFT', '',
          `- Artifact Blocks: ${artifacts.length}`,
          `- Acceptances: ${acceptanceDraftItems(db, draft.draft_id).length}`,
          ...[...blockCounts].map(([block, count]) => `  - ${block}: ${count}`),
          ...artifacts.map((artifact) =>
              `- \`${artifact.artifact_id}.${artifact.block_id}${artifact.item_key ? `.${artifact.item_key}` : ''}\``,
          ),
          `- Decisions: ${decisions.length}`,
          ...decisions.map((decision) => {
              const answer = answers.get(decision.decision_key);
              return `  - ${decision.decision_key}: ${decision.status}${answer?.answer ? ` · answered=${answer.answer}` : ''}`;
          }),
          `- Checks: ${checkRows(db, draft.draft_id).length}`,
          `- Runtime Inputs: ${runtimeInputRows(db, draft).length}`,
          ...runtimeInputRows(db, draft).map((input) => `  - ${input.request_key}: ${input.answer ? `answered=${input.answer}` : 'waiting'}`),
      ].join('\n');
  }
  /** 读取草稿与冻结输入，生成可恢复的状态视图，不把普通文本当提交结果。 */
  function renderStatus(db, draft) {
      return [
          '# COMMAND RESULT', '', '- Command: status', '- Outcome: state_restored', '',
          renderWorkPacket(db, draft),
      ].join('\n');
  }
  function decisionQuestions(decisions) {
      return decisions.filter((decision) => decision.status === 'needs_user_input').map((decision) => ({
          decisionKey: decision.decision_key,
          title: decision.value.title,
          question: decision.value.question,
          why: decision.value.impact,
          recommendation: decision.value.options
              .find((option) => option.id === decision.value.recommendation.option)?.label || '',
          recommendationReason: decision.value.recommendation.reason,
          alternatives: decision.value.options.map((option) => ({
              id: option.id,
              label: option.label,
              consequences: [option.consequence],
          })),
          dependsOn: decision.value.dependencies.map((dependency) => dependency.decision),
          activation: decision.value.dependencies.map((dependency) => ({
              decisionKey: dependency.decision,
              optionId: dependency.option,
          })),
          initialStatus: decision.value.dependencies.length ? 'conditional' : 'pending',
      }));
  }
  function markdownArtifactValue(value) {
      if (Array.isArray(value))
          return value.map(String).join('、');
      if (value && typeof value === 'object') {
          return Object.entries(value)
              .map(([key, item]) => `  - ${key}：${markdownArtifactValue(item)}`)
              .join('\n');
      }
      return String(value ?? '');
  }
  const PRIMARY_ARTIFACT_FIELDS = [
      'claim', 'name', 'title', 'content', 'outcome', 'action', 'statement', 'reason',
      'subject', 'state', 'expected', 'finding', 'summary', 'target', 'kind',
  ];
  const ARTIFACT_ENUM_LABELS = {
      high: '高',
      medium: '中',
      low: '低',
      included: '范围内',
      excluded: '范围外',
      main: '主流程',
      exception: '异常流程',
      recovery: '恢复流程',
      passed: '通过',
      gap: '存在缺口',
      intent: '需求意图',
      business_design: '业务方案',
      specification: '需求规格',
  };
  function markdownLink(label, url) {
      return `[${label.replaceAll(']', '\\]')}](${url.replaceAll(')', '%29')})`;
  }
  function artifactFieldValue(name, value, row) {
      if (name === 'sourceTitle' && typeof value === 'string' && typeof row.sourceUrl === 'string') {
          return markdownLink(value, row.sourceUrl);
      }
      if (typeof value === 'string' && ARTIFACT_ENUM_LABELS[value])
          return ARTIFACT_ENUM_LABELS[value];
      if (typeof value === 'string' && /^https?:\/\//.test(value))
          return markdownLink(value, value);
      return markdownArtifactValue(value);
  }
  function renderYamlArtifactRows(rows, block) {
      const fieldNames = Object.keys(block.fields);
      return rows.flatMap((row) => {
          const value = row.value;
          const populated = fieldNames.filter((name) => value[name] !== undefined && value[name] !== null && value[name] !== '');
          const primary = PRIMARY_ARTIFACT_FIELDS.find((name) => populated.includes(name)) || populated[0];
          if (!primary)
              return [];
          const emphasize = ['name', 'title', 'subject', 'state'].includes(primary);
          const primaryValue = artifactFieldValue(primary, value[primary], value);
          const lines = [`- ${emphasize ? `**${primaryValue}**` : primaryValue}`];
          for (const name of populated) {
              if (name === primary || (name === 'sourceUrl' && populated.includes('sourceTitle')))
                  continue;
              const field = block.fields[name];
              lines.push(`  - **${field.label || name}**：${artifactFieldValue(name, value[name], value)}`);
          }
          return [...lines, ''];
      });
  }
  function normalizeEmbeddedMarkdown(content) {
      let fenced = false;
      return content.trim().split('\n').map((line) => {
          if (/^\s*(```|~~~)/.test(line)) {
              fenced = !fenced;
              return line;
          }
          if (fenced)
              return line;
          return line.replace(/^(\s*)(#{1,6})(\s+)/, (_match, indent, hashes, spacing) => (`${indent}${'#'.repeat(Math.min(6, hashes.length + 2))}${spacing}`));
      }).join('\n');
  }
  function renderPublishedArtifact(definition, artifacts, onlyBlockIds) {
      const entries = Object.entries(definition.artifacts);
      if (entries.length !== 1)
          throw new Error(`命令链 ${definition.id} 必须且只能声明一个最终 Artifact`);
      const [artifactId, artifact] = entries[0];
      const blocks = Object.entries(artifact.blocks).filter(([blockId, block]) => (block.render && (!onlyBlockIds || onlyBlockIds.includes(blockId))));
      const populated = blocks.map(([blockId, block]) => ({
          blockId,
          block,
          rows: artifacts.filter((row) => row.artifact_id === artifactId && row.block_id === blockId),
      })).filter(({ rows }) => rows.length);
      if (populated.length === 1 && populated[0].block.format === 'markdown') {
          return populated[0].rows.map((row) => String(row.value)).join('\n\n').trim();
      }
      const lines = [`# ${artifact.title}`, ''];
      for (const { block, rows } of populated) {
          if (!rows.length)
              continue;
          lines.push(`## ${block.title}`, '');
          if (block.format === 'markdown') {
              lines.push(...rows.flatMap((row) => [normalizeEmbeddedMarkdown(String(row.value)), '']));
              continue;
          }
          if (block.format === 'text') {
              lines.push(...rows.flatMap((row) => [String(row.value), '']));
              continue;
          }
          lines.push(...renderYamlArtifactRows(rows, block));
      }
      return lines.join('\n').trim();
  }
  function renderRequirementContextArtifact(context, decisions) {
      const assertions = (perspective) => context.assertions.filter((assertion) => assertion.perspective === perspective);
      const impacts = (disposition) => context.impacts.filter((impact) => impact.disposition === disposition);
      const lines = [
          '# 业务变化上下文', '',
          '## BUSINESS INTENT', '', context.intent, '',
          '## AS-IS', '',
          '### Actual', '', ...assertions('actual').map((assertion) => `- ${assertion.statement}\n  - 来源：${assertion.source}`), '',
          '### Existing Expected', '',
          ...(assertions('expected').length
              ? assertions('expected').map((assertion) => `- ${assertion.statement}\n  - 来源：${assertion.source}`)
              : ['- 未识别到独立于本次 TO-BE 的既有 Expected']), '',
      ];
      if (decisions.length) {
          lines.push('## DECISIONS', '', ...decisions.map((decision) => {
              const selected = decision.value.options.find((option) => option.id === decision.selected_option_id);
              return `- **${decision.value.title}**：${decision.decision_text || selected?.label || decision.status}`
                  + `${decision.rationale ? `\n  - 依据：${decision.rationale}` : ''}`;
          }), '');
      }
      lines.push('## TO-BE', '', ...assertions('target').map((assertion) => `- ${assertion.statement}`), '', '## CHANGE', '', context.changeSummary, '', '## IMPACTS', '', '### Change', '', ...impacts('change').map((impact) => `- ${impact.statement}\n  - 依据：${impact.rationale}`), '', '### Preserve', '', ...impacts('preserve').map((impact) => `- ${impact.statement}\n  - 依据：${impact.rationale}`), '', '### Analysis Obligations', '', ...impacts('technical').map((impact) => `- ${impact.statement}\n  - 依据：${impact.rationale}`), '', '## SCOPE', '', '### In Scope', '', ...context.scope.filter((item) => item.direction === 'included').map((item) => `- ${item.content}`), '', '### Out of Scope', '', ...(context.scope.some((item) => item.direction === 'excluded')
          ? context.scope.filter((item) => item.direction === 'excluded').map((item) => `- ${item.content}`)
          : ['- 无单独排除项']), '', '## CONSTRAINTS', '', ...(context.constraints.length ? context.constraints.map((item) => `- ${item.content}`) : ['- 无额外约束']), '', '## ACCEPTANCE', '', ...context.acceptance.map((item) => (`- **${item.key}**：${item.content}\n  - Oracle：${item.oracle}\n  - 来源：${item.source}`)));
      return lines.join('\n');
  }
  function renderReproductionArtifact(db, draft) {
      const artifacts = decodedArtifacts(artifactRows(db, draft.draft_id));
      const verdict = (artifacts.find((artifact) => artifact.block_id === 'verdict')?.value || {});
      const many = (block) => artifacts.filter((artifact) => artifact.block_id === block);
      const steps = many('steps');
      const evidence = many('evidence');
      const hypotheses = many('hypotheses');
      return [
          '# 问题复现记录', '',
          `- 结论：${verdict.status || '未登记'}`, '',
          '## 预期行为', '', verdict.expectedBehavior || '', '',
          '## 实际行为', '', verdict.actualBehavior || '', '',
          '## 环境与前置条件', '', verdict.environment || '', '',
          '## 最小复现步骤', '',
          ...steps.map((step, index) => {
              const value = step.value;
              return `${index + 1}. ${value.action}\n   - 期望：${value.expected}\n   - 实际：${value.actual}`;
          }), '',
          '## 证据', '',
          ...evidence.map((item) => {
              const value = item.value;
              return `- **${value.kind} · ${item.item_key}**：${value.content}（来源：${value.source}）`;
          }), '',
          '## 稳定性与对照实验', '', verdict.stability || '', '',
          '## 最小影响范围', '', verdict.impactScope || '', '',
          '## 调查方向', '',
          ...hypotheses.map((item) => {
              const value = item.value;
              return `- **${value.status === 'excluded' ? '已排除' : '待验证'} · ${item.item_key}**：${value.statement}（依据：${value.evidence}）`;
          }),
      ].join('\n');
  }
  function buildDeliveryAnalysisSpec(db, draft) {
      const definition = definitionForDraft(draft);
      const artifacts = decodedArtifacts(artifactRows(db, draft.draft_id));
      const decisions = decodedDecisions(decisionRows(db, draft.draft_id), definition);
      const one = (block) => artifacts.find((row) => row.block_id === block);
      const many = (block) => artifacts.filter((row) => row.block_id === block);
      const spec = {
          unit: currentDeliveryUnit(db, draft.task_id, draft.story_index),
          acceptances: deliveryUnitAcceptances(db, draft.task_id, draft.story_index).map((acceptance) => ({
              id: acceptance.acceptance_id,
              key: acceptance.acceptance_key,
              scope: acceptance.scope_type,
              statement: acceptance.statement,
              oracle: acceptance.oracle,
              sourceRef: `ACCEPTANCE:${acceptance.acceptance_id}:r${acceptance.revision}`,
              revision: acceptance.revision,
          })),
          summary: String(one('summary')?.value || ''),
          impacts: many('impacts').map((row) => {
              const value = row.value;
              return {
                  key: row.item_key, area: value.area, finding: value.finding,
                  disposition: value.disposition, evidence: value.evidence,
                  ...(value.decision ? { decisionKey: value.decision } : {}),
              };
          }),
          decisions: decisions.map((row) => ({
              key: row.decision_key, type: row.value.type, title: row.value.title,
              question: row.value.question, impact: row.value.impact,
              options: row.value.options.map((option) => ({ id: option.id, label: option.label, consequences: [option.consequence] })),
              status: 'resolved',
              ...(row.selected_option_id ? { selectedOption: row.selected_option_id } : {}),
              authority: row.authority,
              decision: row.decision_text,
              rationale: row.rationale,
              evidence: row.evidence,
          })),
          handoff: {
              implementationGuidance: String(one('contract')?.value || ''),
              guardrails: many('guardrails').map((row) => {
                  const value = row.value;
                  return { key: row.item_key, content: value.content, rationale: value.rationale };
              }),
              verificationFocus: many('verification-focus').map((row) => {
                  const value = row.value;
                  return { key: row.item_key, expected: value.expected, oracle: value.oracle };
              }),
          },
      };
      return deliverySpecSchema.parse(spec);
  }
  function renderArtifact(db, draft) {
      const spec = buildDeliveryAnalysisSpec(db, draft);
      return [
          '# 交付分析', '', `> ${spec.unit.title}`, '', '## 分析结论', '', spec.summary, '',
          '## 实际影响', '', ...spec.impacts.map((impact) => `- **${impact.disposition} · ${impact.area}**：${impact.finding}\n  - 证据：${impact.evidence}`), '',
          '## 关键决策', '', ...(spec.decisions.length ? spec.decisions.map((decision) => decision.status === 'resolved'
              ? `- **${decision.type} · ${decision.title}**：${decision.decision}\n  - 依据：${decision.evidence}`
              : `- **${decision.type} · ${decision.title}**：等待用户确认`) : ['- 无']), '',
          '## 交付契约', '', spec.handoff.implementationGuidance,
      ].join('\n');
  }
  /** 筛选仍与当前 execution、证据和实现版本匹配的开发检查。 */
  function developmentEligibleChecks(db, draft) {
      const checks = checkRows(db, draft.draft_id);
      return activeRecoveries(db, draft).length
          ? checks.filter((check) => check.source_execution_id === draft.status_viewed_execution_id)
          : checks;
  }
  function renderVerificationArtifact(db, draft) {
      const state = verificationState(decodedArtifacts(artifactRows(db, draft.draft_id)));
      const statusLabels = { passed: '通过', failed: '失败', blocked: '受阻' };
      const failureLabels = {
          implementation: '实现问题', specification: '规格问题', environment: '环境条件', inconclusive: '证据不足',
      };
      return [
          '# 独立验证报告', '',
          '## 冻结验证输入', '',
          ...state.sources.map((source) => `- ${source.key} · ${source.kind}：${source.description}\n  - Oracle：${source.oracle}`), '',
          '## 测试计划与执行结果', '',
          ...state.scenarios.flatMap((scenario) => {
              const result = state.results.find((candidate) => candidate.key === scenario.key);
              return [
                  `### ${scenario.title} · ${scenario.channel} · ${result ? statusLabels[result.status] : '未执行'}`, '',
                  `- 准备：${scenario.setup}`, `- 测试步骤：${scenario.steps}`, `- 期望：${scenario.expected}`,
                  `- 覆盖：${scenario.coverageRefs.join('、')}`, `- 证据：${result?.evidence || '尚无'}`,
                  ...(result?.actualBehavior ? [`- 实际：${result.actualBehavior}`] : []),
                  ...(result?.failureKind ? [`- 责任边界：${failureLabels[result.failureKind]}`] : []), '',
              ];
          }),
          '## 证据复核', '', state.review?.summary || '尚未完成证据复核', '',
          '## 残余风险', '', state.review?.residualRisk ? `- ${state.review.residualRisk}` : '- 未发现已知残余风险',
      ].join('\n');
  }
  const REVIEW_SECTION_HEADINGS = {
      outcome: '原始目标与最终结果',
      scope: '实际交付范围',
      decisions: '关键决策与取舍',
      implementation: '实现与代码变化',
      verification: '验收与验证证据',
      deviations: '偏差与妥协',
      risks: '已知限制与后续建议',
      feedback: '评论与反馈处理',
  };
  function renderReviewArtifact(db, draft) {
      const state = reviewState(decodedArtifacts(artifactRows(db, draft.draft_id)));
      const order = Object.keys(REVIEW_SECTION_HEADINGS);
      const sections = [...state.sections].sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind));
      return [
          `# ${reviewTaskHeader(db, draft.task_id).title} · 结卡报告`, '',
          ...sections.flatMap((section) => [
              `## ${REVIEW_SECTION_HEADINGS[section.kind]}`, '', section.content, '',
          ]),
          '## 最终事实对账', '',
          ...state.reconciliations.flatMap((reconciliation) => [
              `### ${state.subjects.find((subject) => subject.key === reconciliation.subjectRef)?.kind || 'fact'}`, '',
              reconciliation.result, '',
              `证据边界：已绑定 ${reconciliation.evidenceRefs.length} 项冻结证据。`, '',
          ]),
      ].join('\n').trim();
  }
  /** 调用角色脚本 result 后统一验证 AgentResult；任务状态由外层 Workflow 应用。 */
  function buildResult(db, draft, needsInput) {
      return agentResultSchema.parse(buildScriptResult({ db, draft, needsInput, tools: scriptTools() }));
  }
  function commandChainHelp() {
      return [
          '通用命令链不绑定 Agent namespace。每次 execution 首先执行 status。', '',
          'Delivery Unit：',
          '  delivery-unit current', '',
          'Delivery Spec：',
          '  delivery-spec current', '',
          'Acceptance：',
          '  acceptance get [--key <key>] (read-only, any phase)',
          '  acceptance put --key <key> --content-file <yaml>',
          '  acceptance remove --key <key>',
          '  acceptance assess --key <key> --result <claimed|passed|failed|blocked> --evidence-file <text>', '',
          'Artifact：',
          '  artifact get --artifact <id> [--block <id>] [--key <key>] (read-only, any phase)',
          '  artifact put --artifact <id> --block <id> [--key <key>] --content-file <yaml|markdown>',
          '  artifact template --artifact <id> --block <id>',
          '  artifact remove --artifact <id> --block <id> [--key <key>]', '',
          'Schema：',
          '  schema show --artifact <id> --block <id>',
          '  schema decision --tree <id>', '',
          'Decision：',
          '  decision get --tree <id> [--key <key>] (read-only, any phase)',
          '  decision put --tree <id> --key <key> --content-file <yaml>',
          '  decision template --tree <id>',
          '  decision resolve --tree <id> --key <key> --option <id> --authority <authority> --decision <text> --rationale <text> --evidence <text>',
          '  decision ask|reopen|remove --tree <id> --key <key>', '',
          'Command Check：',
          '  check record --key <key> --receipt <receipt> --summary <summary>',
          '  check remove --key <key>', '',
          'Runtime Input：',
          '  runtime-input put --key <key> --title <title> --question <question> --why <why> --recommendation <recommendation>',
          '  runtime-input remove --key <key>', '',
          'Metadata：',
          '  metadata set --key <key> --value <value>',
          '  metadata remove --key <key>', '',
          'Workflow：',
          '  phase complete',
          '  phase rewind --to <earlier-phase> --reason <reason>',
      ].join('\n');
  }
  /** 领域命令主入口。执行凭证已在引擎校验，此处继续约束阶段与命令归属。 */
  function runCommandChainCommand(input) {
      const { db, execution, draft, command, positionals, flags } = input;
      const definition = definitionForDraft(draft);
      if (command === 'status') {
          if (definition.id === 'review')
              assertReviewExecutionCurrent(db, draft, execution);
          db.prepare(`
        UPDATE agent_work_drafts SET status_viewed_execution_id = ?, last_execution_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE draft_id = ?
      `).run(execution.execution_id, execution.execution_id, draft.draft_id);
          return renderStatus(db, { ...draft, status_viewed_execution_id: execution.execution_id });
      }
      if (command === 'phase complete' && draft.terminal_execution_id === execution.execution_id) {
          return '# COMMAND RESULT\n\n- Command: phase complete\n- Outcome: already_submitted';
      }
      assertViewed(draft, execution.execution_id);
      const state = chainState(db, draft.draft_id);
      const phase = definition.phases[state.workflow_phase];
      if (!phase) throw new Error(`命令脚本缺少活动草稿阶段 ${state.workflow_phase}；请恢复该阶段后继续执行`);
      // Reads are scoped to the already-authorized draft. They never rewind a
      // phase, change an artifact, or expose another execution's work.
      if (command === 'artifact get') {
          const artifactId = required(flags, 'artifact');
          if (!definition.artifacts[artifactId]) throw new Error(`未声明 Artifact：${artifactId}`);
          const blockId = flags.get('block')?.trim();
          const key = flags.get('key')?.trim();
          if (key !== undefined && !blockId) throw new Error('--key 需要同时提供 --block');
          const rows = artifactRows(db, draft.draft_id).filter(row => row.artifact_id === artifactId
              && (!blockId || row.block_id === blockId) && (key === undefined || row.item_key === key));
          if (!rows.length) throw new Error('当前草稿中没有匹配的 Artifact 记录');
          return ['# COMMAND RESULT', '', '- Command: artifact get', '- Outcome: found', '',
              ...rows.flatMap(row => [`## ARTIFACT · ${row.artifact_id}.${row.block_id}${row.item_key ? `.${row.item_key}` : ''}`, '', row.content, '']),
          ].join('\n');
      }
      if (command === 'acceptance get') {
          const key = flags.get('key')?.trim();
          const rows = acceptanceDraftItems(db, draft.draft_id).filter(row => key === undefined || row.acceptance_key === key);
          if (!rows.length) throw new Error('当前草稿中没有匹配的 Acceptance 记录');
          return ['# COMMAND RESULT', '', '- Command: acceptance get', '- Outcome: found', '',
              '```json', JSON.stringify(rows.map(row => ({key:row.acceptance_key,statement:row.statement,oracle:row.oracle,source:row.source})),null,2), '```',
          ].join('\n');
      }
      if (command === 'decision get') {
          const treeId = required(flags, 'tree');
          if (!definition.decisionTrees[treeId]) throw new Error(`未声明 Decision Tree：${treeId}`);
          const key = flags.get('key')?.trim();
          const rows = decisionRows(db, draft.draft_id).filter(row => row.tree_id === treeId && (key === undefined || row.decision_key === key));
          if (!rows.length) throw new Error('当前草稿中没有匹配的 Decision 记录');
          return ['# COMMAND RESULT', '', '- Command: decision get', '- Outcome: found', '',
              '```json', JSON.stringify(rows.map(row => ({key:row.decision_key,status:row.status,selectedOptionId:row.selected_option_id,
                  definition:parse(row.content),resolution:{authority:row.authority,decision:row.decision_text,rationale:row.rationale,evidence:row.evidence}})),null,2), '```',
          ].join('\n');
      }
      if (command === 'schema show' || command === 'artifact template') {
          const artifactId = required(flags, 'artifact');
          const blockId = required(flags, 'block');
          if (!phase.artifactBlocks.some((item) => item.artifactId === artifactId && item.blockId === blockId)) {
              throw new Error(`Artifact Block ${artifactId}/${blockId} 不属于当前 ${state.workflow_phase} Phase`);
          }
          const block = definition.artifacts[artifactId]?.blocks[blockId];
          if (!block)
              throw new Error(`未声明 Artifact Block：${artifactId}/${blockId}`);
          if (command === 'schema show') {
              return [
                  '# COMMAND RESULT', '', '- Command: schema show', '- Outcome: found', '',
                  `## ARTIFACT SCHEMA · ${artifactId}.${blockId}`, '',
                  `- Title: ${block.title}`,
                  `- Shape: ${block.cardinality} · ${block.format} · ${block.required ? 'required' : 'optional'}`,
                  ...artifactSchemaLines(artifactId, blockId, block),
              ].join('\n');
          }
          return [
              '# COMMAND RESULT', '', '- Command: artifact template', '- Outcome: found', '',
              `## ARTIFACT TEMPLATE · ${artifactId}.${blockId}`, '',
              `Copy this ${block.format} template into a file under $LOOP_AGENT_TMP_DIR and replace every REPLACE_ME value.`, '',
              `\`\`\`${block.format === 'text' ? '' : block.format}`, artifactTemplate(block), '\`\`\`',
          ].join('\n');
      }
      if (command === 'schema decision' || command === 'decision template') {
          const treeId = required(flags, 'tree');
          if (!definition.decisionTrees[treeId])
              throw new Error(`未声明 Decision Tree：${treeId}`);
          if (command === 'schema decision') {
              return [
                  '# COMMAND RESULT', '', '- Command: schema decision', '- Outcome: found', '',
                  `## DECISION SCHEMA · ${treeId}`, '', ...decisionSchemaLines(definition, treeId),
              ].join('\n');
          }
          return [
              '# COMMAND RESULT', '', '- Command: decision template', '- Outcome: found', '',
              `## DECISION TEMPLATE · ${treeId}`, '',
              'Copy this YAML template into a file under $LOOP_AGENT_TMP_DIR and replace every REPLACE_ME value.', '',
              '```yaml', decisionTemplate(definition, treeId), '```',
          ].join('\n');
      }
      if (!commandAllowed(definition, state.workflow_phase, command)) {
          const work = phase.workCommands.length ? phase.workCommands.join('；') : '无；本阶段只读取冻结输入，不创建或修改产物';
          throw new Error(`命令 ${command} 不属于当前 ${state.workflow_phase} 工作包。当前工作命令：${work}。满足阶段条件后调用原生 loopwork：${JSON.stringify({args:phase.completeCommand.split(' ')})}。需要完整工作包时执行 status；不要猜测未声明命令。`);
      }
      if (command === 'delivery-unit current') {
          const unit = currentDeliveryUnit(db, draft.task_id, draft.story_index);
          return [
              '# COMMAND RESULT', '',
              '- Command: delivery-unit current',
              '- Outcome: found', '',
              '## DELIVERY UNIT', '',
              '```yaml', stringify(unit).trim(), '```',
          ].join('\n');
      }
      if (command === 'delivery-spec current') {
          const spec = currentDeliverySpec(db, draft.task_id, draft.story_index);
          return [
              '# COMMAND RESULT', '',
              '- Command: delivery-spec current',
              '- Outcome: found', '',
              '## DELIVERY SPEC', '',
              '```yaml', stringify(spec).trim(), '```',
          ].join('\n');
      }
      if (command === 'metadata set' || command === 'metadata remove') {
          const phase = definition.phases[state.workflow_phase];
      if (!phase) throw new Error(`命令脚本缺少活动草稿阶段 ${state.workflow_phase}；请恢复该阶段后继续执行`);
          if (phase.type !== 'metadata')
              throw new Error('只有 Metadata Phase 可以修改需求 Metadata');
          const key = required(flags, 'key');
          const allowedInputs = phase.inputs.map((inputId) => ({ inputId, ...definition.inputs[inputId] }));
          const declared = allowedInputs.find((input) => input.metadataKey === key);
          if (!declared)
              throw new Error(`Metadata key ${key} 不属于当前 ${state.workflow_phase} Phase`);
          if (command === 'metadata set') {
              const value = required(flags, 'value');
              const [parsed] = parseRequirementMetadata([{ key, value }]);
              if (!parsed)
                  throw new Error(`Metadata ${key} 不能为空`);
              db.prepare(`
          INSERT INTO requirement_metadata(task_id, metadata_key, metadata_value)
          VALUES(?, ?, ?)
          ON CONFLICT(task_id, metadata_key) DO UPDATE SET
            metadata_value = excluded.metadata_value,
            updated_at = CURRENT_TIMESTAMP
        `).run(draft.task_id, parsed.key, parsed.value);
              touchDraft(db, draft.draft_id);
              return `# COMMAND RESULT\n\n- Command: metadata set\n- Outcome: accepted\n- Changed: ${key}`;
          }
          const result = db.prepare(`
        DELETE FROM requirement_metadata WHERE task_id = ? AND metadata_key = ?
      `).run(draft.task_id, key);
          if (!result.changes)
              throw new Error(`Metadata 不存在：${key}`);
          touchDraft(db, draft.draft_id);
          return `# COMMAND RESULT\n\n- Command: metadata remove\n- Outcome: accepted\n- Changed: ${key}`;
      }
      if (command === 'acceptance put') {
          if (definition.id !== 'requirement-context')
              throw new Error('只有 Requirement Context 可以定义 Acceptance');
          const key = bounded(required(flags, 'key'), 'Acceptance key', 120);
          if (!/^[a-z0-9][a-z0-9._:-]*$/.test(key)) {
              throw new Error('Acceptance key 只能使用小写字母、数字、点、下划线、冒号和连字符');
          }
          if (key.startsWith('unit:'))
              throw new Error('unit: 前缀由 Harness 为 Delivery Unit Acceptance 保留');
          const value = parseObject(required(flags, 'content'), `acceptance/${key}`);
          const statement = bounded(String(value.statement || ''), 'Acceptance statement', 4000);
          const oracle = bounded(String(value.oracle || ''), 'Acceptance oracle', 4000);
          const source = bounded(String(value.source || ''), 'Acceptance source', 4000);
          const ordinal = nextOrdinal(db, 'command_chain_acceptance_items', draft.draft_id);
          db.prepare(`
        INSERT INTO command_chain_acceptance_items(
          draft_id, acceptance_key, statement, oracle, source, ordinal
        ) VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id, acceptance_key) DO UPDATE SET
          statement = excluded.statement, oracle = excluded.oracle, source = excluded.source,
          updated_at = CURRENT_TIMESTAMP
      `).run(draft.draft_id, key, statement, oracle, source, ordinal);
          touchDraft(db, draft.draft_id);
          return `# COMMAND RESULT\n\n- Command: acceptance put\n- Outcome: accepted\n- Changed: ${key}`;
      }
      if (command === 'acceptance remove') {
          if (definition.id !== 'requirement-context')
              throw new Error('只有 Requirement Context 可以删除 Acceptance 定义');
          const key = required(flags, 'key');
          const result = db.prepare(`
        DELETE FROM command_chain_acceptance_items WHERE draft_id = ? AND acceptance_key = ?
      `).run(draft.draft_id, key);
          if (!result.changes)
              throw new Error(`Acceptance 不存在：${key}`);
          touchDraft(db, draft.draft_id);
          return '# COMMAND RESULT\n\n- Command: acceptance remove\n- Outcome: accepted';
      }
      if (command === 'acceptance assess') {
          if (definition.id !== 'development') {
              throw new Error('当前命令链不能提交 Acceptance 实现声明');
          }
          const key = required(flags, 'key');
          const result = required(flags, 'result');
          if (result !== 'claimed')
              throw new Error('Dev Agent 只能提交 result=claimed 的实现声明');
          const evidence = bounded(required(flags, 'evidence'), 'Acceptance evidence', 20_000);
          const spec = currentDeliverySpec(db, draft.task_id, draft.story_index);
          const acceptance = spec.acceptances.find((candidate) => candidate.key === key);
          if (!acceptance)
              throw new Error(`Delivery Spec 不包含 Acceptance：${key}`);
          const stored = db.prepare(`
        SELECT acceptance_id FROM acceptances
        WHERE acceptance_id = ? AND task_id = ? AND lifecycle = 'active'
      `).get(acceptance.id, draft.task_id);
          if (!stored)
              throw new Error(`Acceptance 实体不存在或已失效：${key}`);
          db.prepare(`
        INSERT INTO acceptance_assessments(
          assessment_id, draft_id, acceptance_id, task_id, story_index,
          kind, agent, execution_id, result, evidence
        ) VALUES(?, ?, ?, ?, ?, 'implementation', 'dev-agent', ?, 'claimed', ?)
        ON CONFLICT(draft_id, acceptance_id, kind) DO UPDATE SET
          execution_id = excluded.execution_id, result = excluded.result,
          evidence = excluded.evidence, updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), draft.draft_id, acceptance.id, draft.task_id, draft.story_index, execution.execution_id, evidence);
          touchDraft(db, draft.draft_id);
          return `# COMMAND RESULT\n\n- Command: acceptance assess\n- Outcome: accepted\n- Acceptance: ${key}`;
      }
      if (command === 'artifact put') {
          const artifactId = required(flags, 'artifact');
          const blockId = required(flags, 'block');
          const phase = definition.phases[state.workflow_phase];
      if (!phase) throw new Error(`命令脚本缺少活动草稿阶段 ${state.workflow_phase}；请恢复该阶段后继续执行`);
          if (!phase.artifactBlocks.some((item) => item.artifactId === artifactId && item.blockId === blockId)) {
              throw new Error(`Artifact Block ${artifactId}/${blockId} 不属于当前 ${state.workflow_phase} Phase`);
          }
          const block = definition.artifacts[artifactId]?.blocks[blockId];
          if (!block)
              throw new Error(`未声明 Artifact Block：${artifactId}/${blockId}`);
          if (!block.writable)
              throw new Error(`Artifact Block ${artifactId}/${blockId} 由 Harness 管理，只读`);
          const itemKey = block.cardinality === 'many' ? bounded(required(flags, 'key'), 'Artifact item key', 120) : '';
          if (definition.id === 'verification' && artifactId === 'verification' && blockId === 'results') {
              const scenarios = verificationState(decodedArtifacts(artifactRows(db, draft.draft_id))).scenarios;
              if (!scenarios.some(scenario => scenario.key === itemKey))
                  throw new Error(`验证结果引用了不存在的场景：${itemKey}；results 的 --key 必须与原场景完全相同，不添加 result: 前缀。可用 key：${scenarios.map(scenario => scenario.key).join('、')}`);
          }
          if (definition.id === 'verification' && blockId === 'scenarios') {
              const existing = db.prepare(`
          SELECT content FROM command_chain_artifact_blocks
          WHERE draft_id = ? AND artifact_id = ? AND block_id = ? AND item_key = ?
        `).get(draft.draft_id, artifactId, blockId, itemKey);
              // Check references before persisting: an invalid appended scenario
              // must not become an immutable obligation that cannot be repaired.
              const candidate = parseObject(validateBlockContent(block, required(flags, 'content'), `${artifactId}/${blockId}/${itemKey}`, { artifactId, blockId }), itemKey);
              const sources = new Set(verificationState(decodedArtifacts(artifactRows(db, draft.draft_id))).sources.map(source => source.key));
              const unknown = candidate.coverageRefs.filter(key => !sources.has(key));
              if (unknown.length) throw new Error(`场景 ${itemKey} 引用了不存在的验证输入：${unknown.join('、')}；coverageRefs 请使用冻结 key：${[...sources].join('、')}`);
              const executePhase = phaseIdForBuiltin(definition, 'verification-execution');
              const frozen = phase.builtin === 'verification-execution' || Boolean(db.prepare(`
          SELECT 1 FROM command_chain_phase_transitions
          WHERE draft_id = ? AND (from_phase = ? OR to_phase = ?) LIMIT 1
        `).get(draft.draft_id, executePhase, executePhase));
              if (existing && frozen) {
                  const previous = parseObject(existing.content, itemKey);
                  const { coverageRefs: oldRefs, ...oldOracle } = previous;
                  const { coverageRefs: newRefs, ...newOracle } = candidate;
                  const changedFields = [...new Set([...Object.keys(oldOracle), ...Object.keys(newOracle)])]
                      .filter(key => JSON.stringify(oldOracle[key]) !== JSON.stringify(newOracle[key]));
                  // Replaying the same frozen item is safe and does not advance
                  // the draft revision or erase any independently recorded result.
                  if (!changedFields.length && JSON.stringify(oldRefs) === JSON.stringify(newRefs))
                      return `# COMMAND RESULT\n\n- Command: ${command}\n- Outcome: unchanged\n- Frozen scenario: ${itemKey}`;
                  // Older drafts can contain invalid reference metadata. Repair
                  // only that metadata, retaining the complete original Oracle
                  // and any observations. A rewind never unlocks expectations.
                  const referenceRepair = oldRefs.some(key => !sources.has(key)) && !changedFields.length;
                  if (!referenceRepair) throw new Error(`验证计划已经冻结，不能覆盖既有场景 ${itemKey}；新风险请使用新的稳定 key。错误 coverageRefs 可在其余字段完全不变时纠正。${changedFields.length ? `本次改动了冻结字段：${changedFields.join('、')}` : '当前来源引用已经有效，不可重新绑定；验证结果请写入 results 下的原 key'}`);
              }
          }
          const content = validateBlockContent(block, required(flags, 'content'), `${artifactId}/${blockId}/${itemKey || 'singleton'}`, { artifactId, blockId });
          if (definition.id === 'review' && ['reconciliations', 'gaps'].includes(blockId)) {
              const nextSubject = String(parseObject(content, `${blockId}/${itemKey}`).subjectRef || '');
              const existing = db.prepare(`
          SELECT content FROM command_chain_artifact_blocks
          WHERE draft_id = ? AND artifact_id = ? AND block_id = ? AND item_key = ?
        `).get(draft.draft_id, artifactId, blockId, itemKey);
              const previousSubject = existing
                  ? String(parseObject(existing.content, `${blockId}/${itemKey}`).subjectRef || '')
                  : '';
              if (previousSubject && previousSubject !== nextSubject) {
                  throw new Error(`稳定 key ${itemKey} 已绑定 ${previousSubject}，不能改绑到 ${nextSubject}`);
              }
              const review = reviewState(decodedArtifacts(artifactRows(db, draft.draft_id)));
              if (!review.subjects.some(subject => subject.key === nextSubject))
                  throw new Error(`未冻结的对账对象：${nextSubject}；subjectRef 必须逐字复制 FROZEN REVIEW SUBJECTS 中的 key，说明写在 result 或 reason 中。`);
              const duplicate = [
                  ...review.reconciliations.map(item => ({...item,block:'reconciliations'})),
                  ...review.gaps.map(item => ({...item,block:'gaps'})),
              ].find(item => item.subjectRef === nextSubject && (item.block !== blockId || item.key !== itemKey));
              if (duplicate) throw new Error(`冻结对象 ${nextSubject} 已由 ${duplicate.block}/${duplicate.key} 处理；修订时复用该原 key。若改为另一类结论，先 artifact remove --artifact review --block ${duplicate.block} --key ${duplicate.key}，再登记。不能给同一对象追加重复对账。`);
              if (blockId === 'reconciliations') {
                  const candidate = parseObject(content, `${blockId}/${itemKey}`);
                  const unknown = candidate.evidenceRefs.filter(ref => !review.evidenceSources.some(source => source.ref === ref));
                  if (unknown.length) throw new Error(`对账引用了未冻结证据：${unknown.join('、')}；evidenceRefs 必须逐字复制冻结 ref，不添加版本后缀、括号或解释。可用独立 Test 引用：${review.evidenceSources.filter(source => source.independentTest).map(source => source.ref).join('、') || '无'}。说明写在 result 中。`);
              }
              if (blockId === 'gaps' && review.meta?.mode === 'report_correction') {
                  throw new Error('报告表达更正不能创建结卡缺口；请由 Feedback Agent 重新分流');
              }
          }
          const ordinal = nextOrdinal(db, 'command_chain_artifact_blocks', draft.draft_id);
          db.prepare(`
        INSERT INTO command_chain_artifact_blocks(
          draft_id, artifact_id, block_id, item_key, content_format, content, ordinal
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id, artifact_id, block_id, item_key) DO UPDATE SET
          content_format = excluded.content_format, content = excluded.content, updated_at = CURRENT_TIMESTAMP
      `).run(draft.draft_id, artifactId, blockId, itemKey, block.format, content, ordinal);
          touchDraft(db, draft.draft_id);
          return `# COMMAND RESULT\n\n- Command: ${command}\n- Outcome: accepted\n- Changed: ${artifactId}/${blockId}/${itemKey || 'singleton'}`;
      }
      if (command === 'artifact remove') {
          const artifactId = required(flags, 'artifact');
          const blockId = required(flags, 'block');
          const phase = definition.phases[state.workflow_phase];
      if (!phase) throw new Error(`命令脚本缺少活动草稿阶段 ${state.workflow_phase}；请恢复该阶段后继续执行`);
          if (!phase.artifactBlocks.some((item) => item.artifactId === artifactId && item.blockId === blockId)) {
              throw new Error(`Artifact Block ${artifactId}/${blockId} 不属于当前 ${state.workflow_phase} Phase`);
          }
          const block = definition.artifacts[artifactId]?.blocks[blockId];
          if (!block)
              throw new Error(`未声明 Artifact Block：${artifactId}/${blockId}`);
          if (!block.writable)
              throw new Error(`Artifact Block ${artifactId}/${blockId} 由 Harness 管理，只读`);
          const executePhase = definition.id === 'verification' ? phaseIdForBuiltin(definition, 'verification-execution') : null;
          if (definition.id === 'verification' && blockId === 'scenarios' && (phase.builtin === 'verification-execution' || db.prepare(`
        SELECT 1 FROM command_chain_phase_transitions
        WHERE draft_id = ? AND (from_phase = ? OR to_phase = ?) LIMIT 1
      `).get(draft.draft_id, executePhase, executePhase))) {
              throw new Error('验证计划已经冻结，不能删除场景。若 coverageRefs 填写错误，使用 artifact put 和原 key，仅修正为有效冻结 key；channel/title/setup/steps/expected 等其他字段必须完全不变，原验证结果保留');
          }
          const itemKey = block.cardinality === 'many' ? required(flags, 'key') : '';
          const result = db.prepare(`
        DELETE FROM command_chain_artifact_blocks
        WHERE draft_id = ? AND artifact_id = ? AND block_id = ? AND item_key = ?
      `).run(draft.draft_id, artifactId, blockId, itemKey);
          if (!result.changes)
              throw new Error(`Artifact item 不存在：${artifactId}/${blockId}/${itemKey || 'singleton'}`);
          touchDraft(db, draft.draft_id);
          return `# COMMAND RESULT\n\n- Command: ${command}\n- Outcome: accepted`;
      }
      if (command === 'runtime-input put') {
          const key = bounded(required(flags, 'key'), 'runtime input key', 120);
          const ordinal = nextOrdinal(db, 'command_chain_runtime_inputs', draft.draft_id);
          db.prepare(`
        INSERT INTO command_chain_runtime_inputs(
          draft_id, request_key, title, question, why, recommendation, ordinal
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id, request_key) DO UPDATE SET
          title = excluded.title, question = excluded.question, why = excluded.why,
          recommendation = excluded.recommendation, updated_at = CURRENT_TIMESTAMP
      `).run(draft.draft_id, key, bounded(required(flags, 'title'), 'runtime input title', 200), bounded(required(flags, 'question'), 'runtime input question', 4000), bounded(required(flags, 'why'), 'runtime input why', 1000), bounded(required(flags, 'recommendation'), 'runtime input recommendation', 2000), ordinal);
          touchDraft(db, draft.draft_id);
          return `# COMMAND RESULT\n\n- Command: ${command}\n- Outcome: accepted\n- Changed: runtime-input/${key}`;
      }
      if (command === 'runtime-input remove') {
          const result = db.prepare(`
        DELETE FROM command_chain_runtime_inputs WHERE draft_id = ? AND request_key = ?
      `).run(draft.draft_id, required(flags, 'key'));
          if (!result.changes)
              throw new Error('runtime input 不存在');
          touchDraft(db, draft.draft_id);
          return '# COMMAND RESULT\n\n- Command: runtime-input remove\n- Outcome: accepted';
      }
      if (command === 'check record') {
          const key = bounded(required(flags, 'key'), 'check key', 120);
          const receipt = required(flags, 'receipt');
          const captured = capturedCommands(db, execution.execution_id).find((candidate) => candidate.receiptKey === receipt);
          if (!captured)
              throw new Error(`receipt ${receipt} 不属于当前 execution 捕获的命令事实`);
          if (!captured.passed)
              throw new Error(`receipt ${receipt} 的命令没有明确成功`);
          if (!captured.commandHash)
              throw new Error(`receipt ${receipt} 缺少可信命令哈希`);
          const ordinal = nextOrdinal(db, 'command_chain_checks', draft.draft_id);
          db.prepare(`
        INSERT INTO command_chain_checks(
          draft_id, check_key, command, command_hash, summary,
          source_execution_id, source_receipt_key, ordinal
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id, check_key) DO UPDATE SET
          command = excluded.command, command_hash = excluded.command_hash,
          summary = excluded.summary, source_execution_id = excluded.source_execution_id,
          source_receipt_key = excluded.source_receipt_key, updated_at = CURRENT_TIMESTAMP
      `).run(draft.draft_id, key, captured.command, captured.commandHash, bounded(required(flags, 'summary'), 'check summary', 4000), execution.execution_id, receipt, ordinal);
          touchDraft(db, draft.draft_id);
          return `# COMMAND RESULT\n\n- Command: ${command}\n- Outcome: accepted\n- Changed: check/${key}`;
      }
      if (command === 'check remove') {
          const result = db.prepare(`DELETE FROM command_chain_checks WHERE draft_id = ? AND check_key = ?`)
              .run(draft.draft_id, required(flags, 'key'));
          if (!result.changes)
              throw new Error('check 不存在');
          touchDraft(db, draft.draft_id);
          return '# COMMAND RESULT\n\n- Command: check remove\n- Outcome: accepted';
      }
      if (command === 'decision put') {
          const treeId = required(flags, 'tree');
          const key = bounded(required(flags, 'key'), 'decision key', 240);
          if (!definition.decisionTrees[treeId])
              throw new Error(`未声明 Decision Tree：${treeId}`);
          const value = parseDecision(required(flags, 'content'), definition, treeId, key);
          const content = stringify(value).trim();
          const existing = db.prepare(`SELECT status FROM command_chain_decisions WHERE draft_id = ? AND tree_id = ? AND decision_key = ?`)
              .get(draft.draft_id, treeId, key);
          if (existing && existing.status !== 'proposed')
              throw new Error(`决策 ${key} 已进入 ${existing.status}，不能覆盖定义；请先 reopen`);
          const ordinal = nextOrdinal(db, 'command_chain_decisions', draft.draft_id);
          db.prepare(`
        INSERT INTO command_chain_decisions(draft_id, tree_id, decision_key, content, ordinal)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(draft_id, tree_id, decision_key) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP
      `).run(draft.draft_id, treeId, key, content, ordinal);
          touchDraft(db, draft.draft_id);
          return `# COMMAND RESULT\n\n- Command: ${command}\n- Outcome: accepted\n- Changed: ${treeId}/${key}`;
      }
      if (command === 'decision remove') {
          const result = db.prepare(`DELETE FROM command_chain_decisions WHERE draft_id = ? AND tree_id = ? AND decision_key = ? AND status = 'proposed'`)
              .run(draft.draft_id, required(flags, 'tree'), required(flags, 'key'));
          if (!result.changes)
              throw new Error('只能删除存在且尚未处理的 decision');
          touchDraft(db, draft.draft_id);
          return '# COMMAND RESULT\n\n- Command: decision remove\n- Outcome: accepted';
      }
      if (command === 'decision resolve') {
          const treeId = required(flags, 'tree');
          const key = required(flags, 'key');
          const row = decisionRows(db, draft.draft_id).find((item) => item.tree_id === treeId && item.decision_key === key);
          if (!row)
              throw new Error(`决策不存在：${key}`);
          const value = parseDecision(row.content, definition, treeId, key);
          const option = required(flags, 'option');
          if (!value.options.some((item) => item.id === option))
              throw new Error(`决策 ${key} 的选项 ${option} 不存在`);
          const authority = required(flags, 'authority');
          if (!definition.decisionTrees[treeId].resolutionAuthorities.includes(authority))
              throw new Error(`决策权限无效：${authority}`);
          const answer = decisionAnswers(db, draft).get(key);
          const hasUserAnswer = Boolean(answer?.answer?.trim() || answer?.selected_option_id);
          if (hasUserAnswer && authority !== 'user')
              throw new Error(`已回答决策 ${key} 必须使用 user 权限关闭`);
          if (!hasUserAnswer && authority === 'user')
              throw new Error(`决策 ${key} 尚无用户答案，不能使用 user 权限关闭`);
          db.prepare(`
        UPDATE command_chain_decisions
        SET status = 'resolved', selected_option_id = ?, authority = ?, decision_text = ?, rationale = ?, evidence = ?, updated_at = CURRENT_TIMESTAMP
        WHERE draft_id = ? AND tree_id = ? AND decision_key = ?
      `).run(option, authority, bounded(required(flags, 'decision'), 'decision'), bounded(required(flags, 'rationale'), 'rationale'), bounded(required(flags, 'evidence'), 'evidence'), draft.draft_id, treeId, key);
          touchDraft(db, draft.draft_id);
          return `# COMMAND RESULT\n\n- Command: ${command}\n- Outcome: accepted`;
      }
      if (command === 'decision ask') {
          if (!['reproduction', 'feedback-triage'].includes(definition.id)
              && analysisDecisionMode(db.prepare(`SELECT metadata_key, metadata_value FROM requirement_metadata WHERE task_id = ?`).all(draft.task_id)) === 'fully_autonomous') {
              throw new Error('完全自主模式不允许把决策提交给用户');
          }
          const result = db.prepare(`
        UPDATE command_chain_decisions SET status = 'needs_user_input', authority = NULL, human_requested = 1, updated_at = CURRENT_TIMESTAMP
        WHERE draft_id = ? AND tree_id = ? AND decision_key = ? AND status = 'proposed'
      `).run(draft.draft_id, required(flags, 'tree'), required(flags, 'key'));
          if (!result.changes)
              throw new Error('只能请求尚未处理的 decision');
          touchDraft(db, draft.draft_id);
          return '# COMMAND RESULT\n\n- Command: decision ask\n- Outcome: accepted';
      }
      if (command === 'decision reopen') {
          const result = db.prepare(`
        UPDATE command_chain_decisions SET status = 'proposed', selected_option_id = NULL, authority = NULL,
          decision_text = NULL, rationale = NULL, evidence = NULL, human_requested = 0, updated_at = CURRENT_TIMESTAMP
        WHERE draft_id = ? AND tree_id = ? AND decision_key = ?
      `).run(draft.draft_id, required(flags, 'tree'), required(flags, 'key'));
          if (!result.changes)
              throw new Error('decision 不存在');
          touchDraft(db, draft.draft_id);
          return '# COMMAND RESULT\n\n- Command: decision reopen\n- Outcome: accepted';
      }
      if (command === 'phase complete' || command === 'phase rewind') {
          const phaseIds = Object.keys(definition.phases);
          const currentIndex = phaseIds.indexOf(state.workflow_phase);
          const rewind = command === 'phase rewind';
          if (!rewind && flags.size)
              throw new Error('phase complete 不接受参数');
          const target = rewind ? required(flags, 'to') : phaseIds[currentIndex + 1];
          const targetIndex = target ? phaseIds.indexOf(target) : -1;
          if (rewind && (!target || targetIndex < 0 || targetIndex >= currentIndex)) {
              throw new Error(`phase rewind 只能回到当前阶段之前的阶段：${phaseIds.slice(0, currentIndex).join('、')}`);
          }
          const phase = definition.phases[state.workflow_phase];
      if (!phase) throw new Error(`命令脚本缺少活动草稿阶段 ${state.workflow_phase}；请恢复该阶段后继续执行`);
          let errors = rewind ? [] : validatorErrors(db, draft, phase.validators);
          const pending = rewind
              ? []
              : decisionRows(db, draft.draft_id).filter((row) => row.status === 'needs_user_input');
          const waitingForDecision = phase.builtin === 'decision-resolution' && pending.length > 0;
          const waitingForRuntimeInput = phase.workCommands.some((candidate) => candidate.startsWith('runtime-input '))
              && runtimeInputRows(db, draft).some((input) => !input.answer);
          const waitingForInput = waitingForDecision || waitingForRuntimeInput;
          // 这里清空错误是为了暂停等待输入，不代表验证通过，也不会继续到下一阶段。
          if (waitingForRuntimeInput) {
              errors = [];
          }
          if (!rewind && !waitingForInput && target && definition.phases[target]?.builtin === 'decision-answer-review') {
              errors.push(...validatorErrors(db, draft, ['decision-complete']));
          }
          if (errors.length)
              throw new Error(`阶段 ${state.workflow_phase} 不能完成：\n${[...new Set(errors)].map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
          if (!rewind && (waitingForInput || !target)) {
              const result = buildResult(db, draft, waitingForInput);
              db.transaction(() => {
                  if (!waitingForInput && !target && definition.id === 'requirement-context') {
                      publishRequirementAcceptances(db, draft);
                  }
                  if (!waitingForInput && !target && definition.id === 'verification') {
                      publishVerificationAssessments(db, draft, execution.execution_id);
                  }
                  db.prepare(`
            UPDATE agent_work_drafts SET status = ?, terminal_action = 'complete', terminal_execution_id = ?,
              submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE draft_id = ?
          `).run(waitingForInput ? 'waiting_for_answers' : 'submitted', execution.execution_id, draft.draft_id);
                  db.prepare(`UPDATE execution_attempts SET status = 'output_received', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP WHERE execution_id = ? AND status = 'running'`)
                      .run(JSON.stringify(result), execution.execution_id);
              })();
              return `# COMMAND RESULT\n\n- Command: phase complete\n- Outcome: ${waitingForInput ? 'waiting_for_human' : 'completed'}\n\n# NEXT\n\n- Owner: Harness`;
          }
          const reason = rewind
              ? bounded(required(flags, 'reason'), '回退原因', 4000)
              : `${state.workflow_phase} 工作包校验通过`;
          db.transaction(() => {
              if (rewind) {
                  const firstArtifactPhase = new Map();
                  for (const [index, phaseId] of phaseIds.entries()) {
                      for (const artifact of definition.phases[phaseId].artifactBlocks) {
                          const reference = `${artifact.artifactId}.${artifact.blockId}`;
                          if (!firstArtifactPhase.has(reference))
                              firstArtifactPhase.set(reference, index);
                      }
                  }
                  for (const [reference, ownerIndex] of firstArtifactPhase) {
                      if (ownerIndex <= targetIndex)
                          continue;
                      const [artifactId, blockId] = reference.split('.');
                      db.prepare(`
              DELETE FROM command_chain_artifact_blocks
              WHERE draft_id = ? AND artifact_id = ? AND block_id = ?
            `).run(draft.draft_id, artifactId, blockId);
                  }
                  if (definition.id === 'requirement-context') {
                      const acceptanceIndex = phaseIds.findIndex((phaseId) => definition.phases[phaseId].builtin === 'acceptance-definition');
                      if (acceptanceIndex > targetIndex) {
                          db.prepare(`DELETE FROM command_chain_acceptance_items WHERE draft_id = ?`).run(draft.draft_id);
                      }
                  }
                  const proposalIndex = phaseIds.findIndex((phaseId) => definition.phases[phaseId].builtin === 'decision-proposal');
                  if (proposalIndex >= 0 && targetIndex <= proposalIndex) {
                      db.prepare(`
              UPDATE command_chain_decisions
              SET status = 'proposed', selected_option_id = NULL, authority = NULL,
                  decision_text = NULL, rationale = NULL, evidence = NULL,
                  human_requested = 0, updated_at = CURRENT_TIMESTAMP
              WHERE draft_id = ?
            `).run(draft.draft_id);
                  }
              }
              if (rewind && definition.id === 'development') {
                  const implementationIndex = phaseIds.indexOf(phaseIdForBuiltin(definition, 'implementation-evidence'));
                  const verificationIndex = phaseIds.indexOf(phaseIdForBuiltin(definition, 'command-verification'));
                  if (targetIndex <= implementationIndex) {
                      db.prepare(`
              DELETE FROM command_chain_artifact_blocks
              WHERE draft_id = ? AND block_id = 'code-review'
            `).run(draft.draft_id);
                  }
                  if (targetIndex <= verificationIndex) {
                      db.prepare(`DELETE FROM command_chain_checks WHERE draft_id = ?`).run(draft.draft_id);
                  }
              }
              db.prepare(`UPDATE command_chain_drafts SET workflow_phase = ?, validated_change_seq = NULL WHERE draft_id = ?`).run(target, draft.draft_id);
              db.prepare(`INSERT INTO command_chain_phase_transitions(draft_id, from_phase, to_phase, reason, execution_id) VALUES(?, ?, ?, ?, ?)`)
                  .run(draft.draft_id, state.workflow_phase, target, reason, execution.execution_id);
              touchDraft(db, draft.draft_id);
          })();
          return [
              '# COMMAND RESULT', '', `- Command: ${command}`, `- Outcome: ${rewind ? 'phase_rewound' : 'phase_completed'}`,
              `- From: ${state.workflow_phase}`, `- To: ${target}`, '', renderWorkPacket(db, draft),
          ].join('\n');
      }
      throw new Error(`未知通用命令：${positionals.join(' ')}`);
  }
  const commandChainDraftInternals = {
      validatorErrors,
      currentDeliveryUnit,
      buildDeliveryAnalysisSpec,
      buildResult,
  };
  function scriptTools() { return { required, bounded, chainState, artifactRows, acceptanceDraftItems, activeRequirementAcceptances, activeTaskAcceptances, deliveryUnitAcceptances, acceptanceAssessments, publishRequirementAcceptances, decisionRows, checkRows, commandFromValue, isHarnessCommand, capturedCommands, runtimeInputRows, activeRecoveries, developmentCriteria, developmentEvidenceErrors, developmentRecoveryErrors, developmentCheckErrors, touchDraft, nextOrdinal, currentDeliveryUnit, currentDeliverySpec, verificationInputSources, initializeVerificationInputs, verificationSourcesMatch, publishVerificationAssessments, stableHash, reviewExecutionInput, reviewExecutionForDraft, reviewTaskHeader, reviewMode, reviewResourceFingerprint, isIndependentReviewTestEvidence, reviewClosureSubjects, reviewCorrectionSubjects, assertReviewExecutionCurrent, insertYamlArtifact, insertReviewArtifact, cloneReviewReportBaseline, initializeReviewInputs, feedbackExecutionContext, initializeFeedbackInputs, initializeCommandChainDraft, cloneCommandChainDraft, parseObject, displayValue, validationFailure, validateBlockContent, parseDecision, definitionForDraft, phaseIdForBuiltin, commandAllowed, assertViewed, decodedArtifacts, decodedDecisions, requirementContextProjection, latestRequirementContextProjection, executionFeedbackGroupId, deliveryPlanInputSources, initializeDeliveryPlanInputs, deliveryPlanState, deliveryPlanErrors, verificationState, verificationPlanErrors, verificationExecutionErrors, reviewState, reviewInputErrors, reviewReconciliationErrors, reviewAssessmentErrors, hasReviewUnitDependencyCycle, reviewOutputErrors, feedbackState, feedbackTriageInputErrors, feedbackTriageCompleteErrors, feedbackVerifyInputErrors, feedbackVerifyCompleteErrors, requirementContextErrors, decisionAnswers, currentAnalysisDecisionMode, requirementMetadataRows, resolvedPhaseInputs, renderPhaseInputs, renderBuiltInContexts, businessAnalysisCompleteErrors, validatorErrors, fieldContract, artifactSchemaLines, artifactTemplate, decisionSchemaLines, decisionTemplate, commandInvocation, sampleFilePath, artifactUsageSample, decisionUsageSample, acceptanceUsageSample, renderWorkPacket, renderStatus, decisionQuestions, markdownArtifactValue, markdownLink, artifactFieldValue, renderYamlArtifactRows, normalizeEmbeddedMarkdown, renderPublishedArtifact, renderRequirementContextArtifact, renderReproductionArtifact, buildDeliveryAnalysisSpec, renderArtifact, developmentEligibleChecks, renderVerificationArtifact, renderReviewArtifact, buildResult, commandChainHelp, runCommandChainCommand, PRIMARY_ARTIFACT_FIELDS, ARTIFACT_ENUM_LABELS, REVIEW_SECTION_HEADINGS, commandChainDraftInternals, createHash, randomUUID, parse, stringify, agentResultSchema, deliverySpecSchema, AgentCommandValidationError, loopAgentCommandPrefix, loadCommandChainDefinition, deliveryUnitContractSchema, analysisDecisionMode, parseRequirementMetadata, requirementMetadataDefinition, requirementMetadataValueLabel }; }

  return { initializeCommandChainDraft, cloneCommandChainDraft, latestRequirementContextProjection, commandChainHelp, runCommandChainCommand };
};
