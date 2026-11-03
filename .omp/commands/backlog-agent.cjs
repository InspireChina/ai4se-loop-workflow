/**
 * 需求梳理：核对变化上下文、范围及 Acceptance。
 *
 * 给维护同事：OMP 原生入口是 /backlog-agent，专业 Prompt 在同目录 backlog-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "backlog-agent",

  // 角色级校验使用真实函数；错误数组由当前阶段的完成门禁消费。
  /** 校验当前阶段的业务完成条件。
   * context.names 只列出本阶段请求的校验；不要把其他阶段的门禁提前套用。
   * artifacts / decisions 是当前草稿投影，tools 来自同目录共享运行库。
   * 返回错误消息数组；非空会阻止阶段完成。规则调整主要修改下面的条件。 */
  validate({ db, draft, names, artifacts, decisions, tools }) {
    const { requirementContextErrors } = tools;
    const errors = [];
    // 变化上下文必须与已关闭决策、范围和验收语义一致。
    if (names.includes('requirement-context-complete')) {
        errors.push(...requirementContextErrors(db, draft, artifacts, decisions));
    }

    return errors;
  },

  /** 把当前草稿组装为结构化 AgentResult，不直接决定下一角色。
   * needsInput=true 表示暂停等待已登记的输入，不是检查通过。
   * 正常分支只能使用已记录的事实和证据；结果仍需通过引擎 Schema 与应用规则。 */
  result({ db, draft, needsInput, tools }) {
    const { definitionForDraft, decodedDecisions, decisionRows, decisionQuestions, agentResultSchema, parse, requirementContextProjection, decodedArtifacts, artifactRows, acceptanceDraftItems, renderRequirementContextArtifact } = tools;
    const definition = definitionForDraft(draft);
    const decisions = decodedDecisions(decisionRows(db, draft.draft_id), definition);
    if (needsInput) {
        const questions = decisionQuestions(decisions);
        return agentResultSchema.parse({
            outcome: 'needs_input',
            summary: `业务变化上下文有 ${questions.length} 个业务边界需要用户确认`,
            artifact: { title: '业务变化上下文决策草稿', content: '完整需求级决策树已经登记，等待用户一次性确认当前批次。' },
            questions,
        });
    }
    const context = requirementContextProjection(draft.draft_id, decodedArtifacts(artifactRows(db, draft.draft_id)), acceptanceDraftItems(db, draft.draft_id));
    return agentResultSchema.parse({
        outcome: 'completed',
        summary: `业务变化上下文已完成：${context.intent}`,
        artifact: {
            title: '业务变化上下文',
            content: renderRequirementContextArtifact(context, decisions),
        },
        questions: [],
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
    define("requirement-context", {
      "version": 1,
      "id": "requirement-context",
      "agent": "backlog-agent",
      "artifacts": {
        "requirement-context": {
          "type": "builtin",
          "title": "业务变化上下文",
          "blocks": {
            "intent": {
              "title": "业务意图",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "assertions": {
              "title": "业务断言",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "perspective": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "actual",
                    "expected",
                    "target"
                  ],
                  "label": "视角"
                },
                "statement": {
                  "type": "string",
                  "required": true,
                  "label": "陈述"
                },
                "evidence": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "observed",
                    "reported",
                    "inferred",
                    "decided",
                    "conflicted"
                  ],
                  "label": "证据性质"
                },
                "source": {
                  "type": "string",
                  "required": true,
                  "label": "来源"
                },
                "decision": {
                  "type": "string",
                  "label": "可选的本草稿已有决策 Key；无关联时省略整个字段"
                }
              }
            },
            "answer-review": {
              "title": "答案复查",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "change-summary": {
              "title": "变化摘要",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "impacts": {
              "title": "业务影响",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "statement": {
                  "type": "string",
                  "required": true,
                  "label": "影响"
                },
                "disposition": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "change",
                    "preserve",
                    "needs_decision",
                    "technical"
                  ],
                  "label": "处置"
                },
                "rationale": {
                  "type": "string",
                  "required": true,
                  "label": "原因"
                },
                "source": {
                  "type": "string",
                  "required": true,
                  "label": "来源"
                },
                "decision": {
                  "type": "string",
                  "label": "可选的本草稿已有决策 Key；无关联时省略整个字段"
                }
              }
            },
            "scope": {
              "title": "范围",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "direction": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "included",
                    "excluded"
                  ],
                  "label": "范围方向"
                },
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "内容"
                }
              }
            },
            "constraints": {
              "title": "约束",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "约束"
                }
              }
            },
            "acceptance": {
              "title": "验收语义",
              "cardinality": "many",
              "format": "yaml",
              "writable": false
            }
          }
        }
      },
      "phases": {
        "as_is": {
          "type": "artifact",
          "artifacts": [
            "requirement-context.intent",
            "requirement-context.assertions"
          ],
          "instructions": "建立足以讨论本次变化的 AS-IS 事实基线。业务意图来自冻结输入；Actual 必须来自可定位的项目事实，Existing Expected 只能来自变更前已有的权威规范。不要提前写 TO-BE、范围或验收语义。"
        },
        "decision_proposal": {
          "type": "builtin",
          "builtin": "decision-proposal"
        },
        "decision_resolution": {
          "type": "builtin",
          "builtin": "decision-resolution"
        },
        "answer_review": {
          "type": "builtin",
          "builtin": "decision-answer-review",
          "artifacts": [
            "requirement-context.answer-review"
          ]
        },
        "to_be": {
          "type": "artifact",
          "artifacts": [
            "requirement-context.assertions"
          ],
          "instructions": "使用 perspective: target 登记最终 TO-BE。每条 Target 都必须可追溯到冻结输入、可靠项目事实或已关闭决定；不要在陈述中隐藏新的业务选择。"
        },
        "impact_scan": {
          "type": "artifact",
          "artifacts": [
            "requirement-context.change-summary",
            "requirement-context.impacts"
          ],
          "instructions": "对比 AS-IS、适用的 Existing Expected 与 TO-BE，登记必须改变、必须保持和需要交付分析继续收敛的影响。发现新的业务分叉时回退 decision_proposal，不要把技术方案登记为影响。"
        },
        "scope": {
          "type": "artifact",
          "artifacts": [
            "requirement-context.scope",
            "requirement-context.constraints"
          ],
          "instructions": "至少登记一项 included 范围；把相关但未选择、独立扩展或推迟的事项登记为 excluded。范围和约束只能收敛已有语义，不能创造新的业务规则。"
        },
        "acceptance": {
          "type": "builtin",
          "builtin": "acceptance-definition",
          "artifacts": [
            "requirement-context.acceptance"
          ]
        },
        "finalize": {
          "type": "builtin",
          "builtin": "requirement-context-finalize"
        }
      }
    })
    ];
  },

};
