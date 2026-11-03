/**
 * 开发实现：实施证据、恢复处理、自验证与交付记录。
 *
 * 给维护同事：OMP 原生入口是 /dev-agent，专业 Prompt 在同目录 dev-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "dev-agent",

  // 角色级校验使用真实函数；错误数组由当前阶段的完成门禁消费。
  /** 校验当前阶段的业务完成条件。
   * context.names 只列出本阶段请求的校验；不要把其他阶段的门禁提前套用。
   * artifacts / decisions 是当前草稿投影，tools 来自同目录共享运行库。
   * 返回错误消息数组；非空会阻止阶段完成。规则调整主要修改下面的条件。 */
  validate({ db, draft, names, artifacts, decisions, tools }) {
    const { developmentEvidenceErrors, developmentRecoveryErrors, developmentCheckErrors } = tools;
    const errors = [];
    // 逐项检查冻结 Acceptance 是否有本轮实施声明。
    if (names.includes('development-criteria')) {
        errors.push(...developmentEvidenceErrors(db, draft));
    }
    // 活动恢复事项必须有可定位的处理记录。
    if (names.includes('development-recovery')) {
        errors.push(...developmentRecoveryErrors(db, draft));
    }
    // 最终汇总实施、恢复、真实检查 receipt 与代码审查；不能只看测试退出码。
    if (names.includes('development-ready')) {
        errors.push(...developmentEvidenceErrors(db, draft));
        errors.push(...developmentRecoveryErrors(db, draft));
        errors.push(...developmentCheckErrors(db, draft));
        if (!artifacts.some((artifact) => artifact.block_id === 'code-review')) {
            errors.push('缺少代码审查 Artifact');
        }
    }

    return errors;
  },

  /** 把当前草稿组装为结构化 AgentResult，不直接决定下一角色。
   * needsInput=true 表示暂停等待已登记的输入，不是检查通过。
   * 正常分支只能使用已记录的事实和证据；结果仍需通过引擎 Schema 与应用规则。 */
  result({ db, draft, needsInput, tools }) {
    const { runtimeInputRows, agentResultSchema, parse, currentDeliverySpec, decodedArtifacts, artifactRows, acceptanceAssessments, developmentEligibleChecks, developmentCriteria } = tools;
    const inputs = runtimeInputRows(db, draft).filter((input) => !input.answer);
    if (needsInput) {
        return agentResultSchema.parse({
            outcome: 'needs_input',
            summary: `开发实现需要补充运行信息：${inputs.map((input) => input.title).join('、')}`,
            runtimeInputs: inputs.map((input) => ({
                key: input.request_key,
                title: input.title,
                question: input.question,
                why: input.why,
                recommendation: input.recommendation,
            })),
        });
    }
    const spec = currentDeliverySpec(db, draft.task_id, draft.story_index);
    const artifacts = decodedArtifacts(artifactRows(db, draft.draft_id));
    const criteria = acceptanceAssessments(db, draft.draft_id, 'implementation');
    const recoveries = artifacts.filter((artifact) => artifact.block_id === 'recovery-resolutions');
    const review = artifacts.find((artifact) => artifact.block_id === 'code-review');
    const risks = artifacts.filter((artifact) => artifact.block_id === 'risks');
    const checks = developmentEligibleChecks(db, draft);
    const reviewValue = (review?.value || {});
    const artifact = [
        '# 开发实现结果', '',
        '## 验收证据', '',
        ...developmentCriteria(spec).map((criterion) => {
            const evidence = criteria.find((item) => item.acceptance_key === criterion.key);
            return `- ${criterion.key} · ${criterion.description}：${evidence?.evidence || '未登记'}`;
        }),
        '', '## 代码审查', '',
        `- 摘要：${reviewValue.summary || '未登记'}`,
        `- 依据：${reviewValue.evidence || '未登记'}`,
        '', '## 本次交付文件', '',
        ...(reviewValue.changedFiles?.length ? reviewValue.changedFiles.map(file => `- ${file}`) : ['- 已明确声明本轮无代码变更']),
        '', '## 开发者关键检查', '',
        ...checks.map((check) => `- 通过 \`${check.command}\`：${check.summary}`),
        '', '## 已知风险', '',
        ...(risks.length
            ? risks.map((risk) => `- ${String(risk.value.content || '')}`)
            : ['- 未发现已知残余风险']),
    ].join('\n');
    return agentResultSchema.parse({
        outcome: 'completed',
        changedFiles: reviewValue.changedFiles,
        summary: `开发实现完成：${criteria.length}/${developmentCriteria(spec).length} 项验收语义已有实现证据，${checks.length} 项开发检查通过。`,
        artifact: { title: '开发实现结果', content: artifact },
        recoveryResolutions: recoveries.map((recovery) => {
            const value = recovery.value;
            return { recoveryId: recovery.item_key, summary: value.summary, evidence: [value.evidence] };
        }),
        tests: checks.map((check) => ({ command: check.command, passed: true, summary: check.summary })),
        runtimeInputs: [],
    });

  },

  /** 为已授权 execution 初始化命令链草稿和冻结输入。
   * 默认调用共享实现；若增加初始化逻辑，保持相同的角色与任务范围。
   * db 是当前实例选定的状态连接，不要借此绕过任务领取、资源锁或调度协议。 */
  initialize(runtime, db, execution, draft) {
    return runtime.initializeCommandChainDraft(db, execution, draft);
  },

  /** 处理一个已解析且已授权的领域命令，同步返回协议文本。
   * invocation 包含 db、execution、draft、command、positionals、flags。
   * 默认实现提供 Artifact / Decision / Phase 等命令；修改公共行为请看共享 runtime。 */
  execute(runtime, invocation) {
    return runtime.runCommandChainCommand(invocation);
  },

  /** 从有效旧草稿恢复到新 execution，保持幂等与已生效事实。
   * 默认实现会按 Dev/Test 规则重置本轮检查或验证证据；不要盲目复制旧 receipt。 */
  restore(runtime, db, source, target) {
    return runtime.cloneCommandChainDraft(db, source, target);
  },

  /** 提供已提交需求上下文的只读投影；Backlog 通过此接口向下游提供事实。 */
  project(runtime, db, taskId) {
    return runtime.latestRequirementContextProjection(db, taskId);
  },

  /** 返回协议帮助。命令语法调整时同步修改共享帮助与工作包，避免 Prompt 使用旧命令。 */
  help(runtime) {
    return runtime.commandChainHelp();
  },

  // 调度器读取下面的阶段描述；专业工作方式仍在同名 Markdown 与 Skill 中维护。
  /** 向 Workflow 描述当前链及阶段顺序，不在此执行任务或产生外部副作用。
   * define 复用 workflow/definitions.cjs 的默认构造与结构检查。
   * 修改步骤顺序、字段或阶段指令后，同步检查同名 Markdown 的专业职责。
   * Flow 角色、Pipeline 和链 ID 仍由调度契约绑定；实际阶段以 status 返回为准。 */
  describe({ define }) {
    return [
    define("development", {
      "version": 1,
      "id": "development",
      "agent": "dev-agent",
      "inputs": {
        "requirement-card": {
          "metadata": "tracking.requirement_card_id"
        }
      },
      "artifacts": {
        "development": {
          "type": "builtin",
          "title": "开发实现结果",
          "blocks": {
            "recovery-resolutions": {
              "title": "恢复事项处理",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "summary": {
                  "type": "string",
                  "required": true,
                  "label": "处理摘要"
                },
                "evidence": {
                  "type": "string",
                  "required": true,
                  "label": "证据"
                }
              }
            },
            "code-review": {
              "title": "代码审查",
              "cardinality": "one",
              "format": "yaml",
              "required": true,
              "fields": {
                "summary": {
                  "type": "string",
                  "required": true,
                  "label": "审查摘要"
                },
                "evidence": {
                  "type": "string",
                  "required": true,
                  "label": "证据"
                },
                "changedFiles": {
                  "type": "array",
                  "itemType": "string",
                  "required": true,
                  "label": "本次实际交付的仓库相对文件路径；无代码变更时明确填写空数组 []"
                }
              }
            },
            "risks": {
              "title": "残余风险",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "风险"
                }
              }
            }
          }
        }
      },
      "phases": {
        "delivery_spec": {
          "type": "builtin",
          "builtin": "delivery-spec"
        },
        "implement": {
          "type": "builtin",
          "builtin": "implementation-evidence",
          "artifacts": [
            "development.recovery-resolutions"
          ]
        },
        "review": {
          "type": "artifact",
          "artifacts": [
            "development.code-review"
          ],
          "instructions": "对当前实现做独立代码审查，确认它遵守仓库规范、模块职责和 Clean Code 原则。登记审查摘要与可定位依据；发现阻塞问题时不要完成本阶段，使用 phase rewind 回到 implement 修正后重新审查。不要用测试通过代替代码质量审查。"
        },
        "developer_verify": {
          "type": "builtin",
          "builtin": "command-verification",
          "artifacts": [
            "development.risks"
          ]
        },
        "commit": {
          "type": "confirmation",
          "inputs": [
            "requirement-card"
          ],
          "instructions": "检查当前交付是否已经形成范围正确的 Git 提交。只提交当前交付相关文件，不混入已有无关改动；没有代码变化时确认无需制造空提交。Phase Input 提供需求卡号时，按目标仓库已有提交说明规范将其作为本次提交的追溯信息，不要扩散到其他产物。发现实现或验证问题时使用 phase rewind 回到对应阶段。"
        },
        "finalize": {
          "type": "confirmation",
          "instructions": "最终检查实现证据、代码审查、真实命令事实、残余风险、恢复事项和提交状态是否一致且完整。发现问题时不要提交，使用 phase rewind 回到对应阶段修正。"
        }
      }
    })
    ];
  },

};
