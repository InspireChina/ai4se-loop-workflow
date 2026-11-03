/**
 * 交付分析：关闭真实影响与决策，形成冻结 Delivery Spec。
 *
 * 给维护同事：OMP 原生入口是 /analyst-agent，专业 Prompt 在同目录 analyst-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "analyst-agent",

  // 角色级校验使用真实函数；错误数组由当前阶段的完成门禁消费。
  /** 校验当前阶段的业务完成条件。
   * context.names 只列出本阶段请求的校验；不要把其他阶段的门禁提前套用。
   * artifacts / decisions 是当前草稿投影，tools 来自同目录共享运行库。
   * 返回错误消息数组；非空会阻止阶段完成。规则调整主要修改下面的条件。 */
  validate({ db, draft, names, artifacts, decisions, tools }) {
    const {  } = tools;
    const errors = [];

    return errors;
  },

  /** 把当前草稿组装为结构化 AgentResult，不直接决定下一角色。
   * needsInput=true 表示暂停等待已登记的输入，不是检查通过。
   * 正常分支只能使用已记录的事实和证据；结果仍需通过引擎 Schema 与应用规则。 */
  result({ db, draft, needsInput, tools }) {
    const { definitionForDraft, decodedDecisions, decisionRows, agentResultSchema, parse, decisionQuestions, buildDeliveryAnalysisSpec, renderArtifact } = tools;
    const definition = definitionForDraft(draft);
    const decisions = decodedDecisions(decisionRows(db, draft.draft_id), definition);
    if (needsInput) {
        return agentResultSchema.parse({
            outcome: 'needs_input',
            summary: `交付分析有 ${decisions.filter((row) => row.status === 'needs_user_input').length} 个关键决策需要用户确认`,
            artifact: { title: '交付分析决策草稿', content: '已登记完整决策树，等待用户一次性确认。' },
            questions: decisionQuestions(decisions),
        });
    }
    const spec = buildDeliveryAnalysisSpec(db, draft);
    return agentResultSchema.parse({
        outcome: 'completed',
        summary: '当前交付单元的影响、决策和冻结交付契约已经收敛',
        artifact: { title: '交付分析', content: renderArtifact(db, draft) },
        spec,
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
    define("delivery-analysis", {
      "version": 2,
      "id": "delivery-analysis",
      "agent": "analyst-agent",
      "artifacts": {
        "delivery-analysis": {
          "type": "builtin",
          "title": "交付分析",
          "blocks": {
            "impacts": {
              "title": "现状与影响扫描",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "area": {
                  "type": "string",
                  "required": true,
                  "label": "影响区域"
                },
                "finding": {
                  "type": "string",
                  "required": true,
                  "label": "发现"
                },
                "disposition": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "change",
                    "preserve",
                    "exclude",
                    "needs_decision"
                  ],
                  "label": "处置"
                },
                "evidence": {
                  "type": "string",
                  "required": true,
                  "label": "证据"
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
            "summary": {
              "title": "交付摘要",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "contract": {
              "title": "交付契约",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "guardrails": {
              "title": "实现护栏",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "护栏"
                },
                "rationale": {
                  "type": "string",
                  "required": true,
                  "label": "原因"
                }
              }
            },
            "verification-focus": {
              "title": "验证重点",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "expected": {
                  "type": "string",
                  "required": true,
                  "label": "预期结果"
                },
                "oracle": {
                  "type": "string",
                  "required": true,
                  "label": "验证 Oracle"
                }
              }
            }
          }
        }
      },
      "phases": {
        "delivery_unit": {
          "type": "builtin",
          "builtin": "delivery-unit"
        },
        "impact_scan": {
          "type": "artifact",
          "artifacts": [
            "delivery-analysis.impacts"
          ],
          "instructions": "读取冻结业务契约与实时项目证据，登记真正会改变、保持、排除或需要决策的影响。每项影响必须提供可定位证据；needs_decision 必须关联稳定 decision key。本阶段不要提前编写最终交付契约。"
        },
        "decision_proposal": {
          "type": "builtin",
          "builtin": "decision-proposal"
        },
        "decision_resolution": {
          "type": "builtin",
          "builtin": "decision-resolution",
          "artifacts": [
            "delivery-analysis.impacts"
          ]
        },
        "answer_review": {
          "type": "builtin",
          "builtin": "decision-answer-review",
          "artifacts": [
            "delivery-analysis.answer-review"
          ]
        },
        "delivery_contract": {
          "type": "artifact",
          "artifacts": [
            "delivery-analysis.summary",
            "delivery-analysis.contract",
            "delivery-analysis.guardrails",
            "delivery-analysis.verification-focus"
          ],
          "instructions": "把已收敛影响和决策登记为 Dev 与 Test 共同依赖的冻结交付契约。summary 和 contract 必须完成；必要时补充 guardrails 与 verification-focus。契约只约束用户可观察结果，不要保存逐文件实现计划或完整测试步骤。"
        },
        "finalize": {
          "type": "confirmation",
          "instructions": "最终检查影响、决策和交付契约是否一致，确认没有遗漏或冲突。发现问题时不要提交，使用 phase rewind 回到对应阶段修正。"
        }
      }
    })
    ];
  },

};
