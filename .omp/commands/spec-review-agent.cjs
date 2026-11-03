/**
 * 独立规格审查：记录发现，批准或形成同一目标的阻断缺口。
 *
 * 给维护同事：OMP 原生入口是 /spec-review-agent，专业 Prompt 在同目录 spec-review-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "spec-review-agent",

  // 角色级校验使用真实函数；错误数组由当前阶段的完成门禁消费。
  /** 校验当前阶段的业务完成条件。
   * context.names 只列出本阶段请求的校验；不要把其他阶段的门禁提前套用。
   * artifacts / decisions 是当前草稿投影，tools 来自同目录共享运行库。
   * 返回错误消息数组；非空会阻止阶段完成。规则调整主要修改下面的条件。 */
  validate({ db, draft, names, artifacts, decisions, tools }) {
    const { businessAnalysisCompleteErrors } = tools;
    const errors = [];
    // 检查正常产物与上游缺口是否互斥、核心材料是否完整。
    if (names.includes('business-analysis-complete')) {
        errors.push(...businessAnalysisCompleteErrors(draft, artifacts));
    }

    return errors;
  },

  /** 把当前草稿组装为结构化 AgentResult，不直接决定下一角色。
   * needsInput=true 表示暂停等待已登记的输入，不是检查通过。
   * 正常分支只能使用已记录的事实和证据；结果仍需通过引擎 Schema 与应用规则。 */
  result({ db, draft, needsInput, tools }) {
    const { definitionForDraft, decodedArtifacts, artifactRows, decodedDecisions, decisionRows, decisionQuestions, agentResultSchema, parse, renderPublishedArtifact } = tools;
    const definition = definitionForDraft(draft);
    const artifacts = decodedArtifacts(artifactRows(db, draft.draft_id));
    const decisions = decodedDecisions(decisionRows(db, draft.draft_id), definition);
    const config = {
        'idea-context': {
            stage: 'intent',
        },
        'business-design': {
            stage: 'business_design',
        },
        'requirement-spec': {
            stage: 'specification',
        },
        'spec-review': {
            stage: 'review',
        },
    }[definition.id];
    if (!config)
        throw new Error(`未知 Business Analysis 命令链：${definition.id}`);
    if (needsInput) {
        const questions = decisionQuestions(decisions);
        return agentResultSchema.parse({
            outcome: 'needs_input',
            summary: `${Object.values(definition.artifacts)[0].title}仍有 ${questions.length} 个业务问题需要用户确认`,
            questions,
            businessAnalysis: { stage: config.stage, disposition: 'advance' },
        });
    }
    const gapBlock = definition.id === 'business-design' || definition.id === 'requirement-spec'
        ? 'upstream-gaps'
        : definition.id === 'spec-review' ? 'gaps' : null;
    const gaps = gapBlock ? artifacts.filter((artifact) => artifact.block_id === gapBlock) : [];
    if (gaps.length) {
        const first = gaps[0].value;
        const target = definition.id === 'business-design' ? 'intent' : String(first.target || '');
        const reason = gaps.map((gap) => {
            const value = gap.value;
            return `${gap.item_key}：${String(value.reason || '')}`;
        }).join('；');
        return agentResultSchema.parse({
            outcome: 'completed',
            summary: reason,
            artifact: {
                title: 'Business Analysis 缺口',
                content: renderPublishedArtifact(definition, artifacts, [gapBlock]),
            },
            businessAnalysis: {
                stage: config.stage,
                disposition: 'return_revision',
                target,
                reason,
            },
        });
    }
    const artifactTitle = Object.values(definition.artifacts)[0].title;
    const content = renderPublishedArtifact(definition, artifacts);
    return agentResultSchema.parse({
        outcome: 'completed',
        summary: definition.id === 'spec-review' ? '需求规格已通过独立审查' : `${artifactTitle}已完成`,
        artifact: { title: artifactTitle, content },
        businessAnalysis: {
            stage: config.stage,
            disposition: definition.id === 'spec-review' ? 'approved' : 'advance',
        },
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
    define("spec-review", {
      "version": 1,
      "id": "spec-review",
      "agent": "spec-review-agent",
      "artifacts": {
        "specification-review": {
          "type": "builtin",
          "title": "需求规格说明书",
          "blocks": {
            "findings": {
              "title": "审查发现",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "render": false,
              "fields": {
                "subject": {
                  "type": "string",
                  "required": true,
                  "label": "审查主题"
                },
                "verdict": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "passed",
                    "gap"
                  ],
                  "label": "结论"
                },
                "evidence": {
                  "type": "string",
                  "required": true,
                  "label": "证据"
                },
                "reason": {
                  "type": "string",
                  "required": true,
                  "label": "原因"
                }
              }
            },
            "gaps": {
              "title": "阻断缺口",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "target": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "intent",
                    "business_design",
                    "specification"
                  ],
                  "label": "回流目标"
                },
                "affectedSections": {
                  "type": "array",
                  "itemType": "string",
                  "required": true,
                  "minItems": 1,
                  "label": "影响章节"
                },
                "evidence": {
                  "type": "string",
                  "required": true,
                  "label": "证据"
                },
                "reason": {
                  "type": "string",
                  "required": true,
                  "label": "缺口"
                }
              }
            },
            "verdict-summary": {
              "title": "审查结论",
              "cardinality": "one",
              "format": "markdown",
              "required": true,
              "render": false
            },
            "approved-specification": {
              "title": "已批准需求规格",
              "cardinality": "one",
              "format": "markdown"
            }
          }
        }
      },
      "phases": {
        "inspection": {
          "type": "artifact",
          "artifacts": [
            "specification-review.findings"
          ],
          "instructions": "为每个重要审查主题登记有证据的 passed 或 gap 发现。不要直接改写上游决定，不检查代码实现，也不要把无关表达偏好升级为阻断缺口。"
        },
        "classification": {
          "type": "artifact",
          "artifacts": [
            "specification-review.gaps"
          ],
          "instructions": "只保留会阻止规格成立的缺口，并使用稳定 key 分类为 intent、business_design 或 specification。所有 gap 必须指向同一个回流目标；不得自行回答缺口。"
        },
        "verdict": {
          "type": "artifact",
          "artifacts": [
            "specification-review.verdict-summary",
            "specification-review.approved-specification"
          ],
          "instructions": "汇总独立审查结论。gaps 为空时登记忠实继承上游的完整 approved-specification；存在 gap 时不要登记批准规格，结论只说明回流原因和证据边界。"
        },
        "finalize": {
          "type": "builtin",
          "builtin": "business-analysis-finalize"
        }
      }
    })
    ];
  },

};
