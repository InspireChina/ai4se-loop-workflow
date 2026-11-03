/**
 * 反馈闭环：批次分流与单条反馈的独立验证。
 *
 * 给维护同事：OMP 原生入口是 /feedback-agent，专业 Prompt 在同目录 feedback-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "feedback-agent",

  // 角色级校验使用真实函数；错误数组由当前阶段的完成门禁消费。
  /** 校验当前阶段的业务完成条件。
   * context.names 只列出本阶段请求的校验；不要把其他阶段的门禁提前套用。
   * artifacts / decisions 是当前草稿投影，tools 来自同目录共享运行库。
   * 返回错误消息数组；非空会阻止阶段完成。规则调整主要修改下面的条件。 */
  validate({ db, draft, names, artifacts, decisions, tools }) {
    const { feedbackTriageInputErrors, feedbackTriageCompleteErrors, feedbackVerifyInputErrors, feedbackVerifyCompleteErrors } = tools;
    const errors = [];
    // 分流只能覆盖当前冻结批次的评论。
    if (names.includes('feedback-triage-inputs')) {
        errors.push(...feedbackTriageInputErrors(db, draft, artifacts));
    }
    // 每条评论恰好归入一个工作组，后续工作必须有范围与验收语义。
    if (names.includes('feedback-triage-complete')) {
        errors.push(...feedbackTriageCompleteErrors(artifacts));
    }
    // 验证只能针对当前冻结评论和工作组。
    if (names.includes('feedback-verify-inputs')) {
        errors.push(...feedbackVerifyInputErrors(db, draft, artifacts));
    }
    // resolved / reopened 必须有独立证据和一致的原因。
    if (names.includes('feedback-verify-complete')) {
        errors.push(...feedbackVerifyCompleteErrors(artifacts));
    }

    return errors;
  },

  /** 组装反馈分流结果：覆盖完整冻结批次，交由 Workflow 追加后续工作。 */
  triageResult({ db, draft, needsInput, tools }) {
    const { decodedArtifacts, artifactRows, feedbackState, decodedDecisions, decisionRows, definitionForDraft, decisionQuestions, agentResultSchema, parse } = tools;
    const artifacts = decodedArtifacts(artifactRows(db, draft.draft_id));
    const state = feedbackState(artifacts);
    if (needsInput) {
        const decisions = decodedDecisions(decisionRows(db, draft.draft_id), definitionForDraft(draft));
        const questions = decisionQuestions(decisions);
        return agentResultSchema.parse({
            outcome: 'needs_input',
            summary: state.summary || `反馈分流仍需确认 ${questions.length} 个边界`,
            questions,
        });
    }
    return agentResultSchema.parse({
        outcome: 'completed',
        summary: state.summary,
        feedback: {
            mode: 'triage',
            groups: state.groups.map((group) => ({
                groupKey: group.key,
                commentIds: group.commentIds,
                workType: group.workType,
                ...(group.title ? { title: group.title } : {}),
                affectedDeliveryUnits: group.affectedDeliveryUnits,
                reason: group.reason,
                acceptance: group.acceptance,
                ...(group.response ? { response: group.response } : {}),
            })),
        },
    });

  },
  /** 组装单条反馈的验证结果：仅处理冻结目标，保留独立观察证据。 */
  verificationResult({ db, draft, needsInput, tools }) {
    const { feedbackState, decodedArtifacts, artifactRows, agentResultSchema, parse } = tools;
    if (needsInput)
        throw new Error('Feedback Verify 不能请求问题或 runtime input');
    const state = feedbackState(decodedArtifacts(artifactRows(db, draft.draft_id)));
    return agentResultSchema.parse({
        outcome: 'completed',
        summary: state.summary,
        feedback: {
            mode: 'verify',
            commentId: state.target?.commentId,
            verdict: state.conclusion?.verdict,
            reason: state.conclusion?.reason,
            evidence: state.evidence.map((item) => item.content),
        },
    });

  },
  /** 把当前草稿组装为结构化 AgentResult，不直接决定下一角色。
   * needsInput=true 表示暂停等待已登记的输入，不是检查通过。
   * 正常分支只能使用已记录的事实和证据；结果仍需通过引擎 Schema 与应用规则。 */
  result(context) {
    return context.draft.command_chain_id === 'feedback-triage' ? this.triageResult(context) : this.verificationResult(context);
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
    define("feedback-triage", {
      "version": 1,
      "id": "feedback-triage",
      "agent": "feedback-agent",
      "artifacts": {
        "feedback": {
          "type": "builtin",
          "title": "反馈分流",
          "blocks": {
            "inputs": {
              "title": "冻结反馈评论",
              "cardinality": "many",
              "format": "yaml",
              "writable": false,
              "required": true,
              "fields": {
                "commentId": {
                  "type": "string",
                  "required": true,
                  "label": "评论 ID"
                }
              }
            },
            "meta": {
              "title": "冻结反馈批次",
              "cardinality": "one",
              "format": "yaml",
              "writable": false,
              "required": true,
              "fields": {
                "batchId": {
                  "type": "string",
                  "required": true,
                  "label": "批次 ID"
                },
                "totalStories": {
                  "type": "string",
                  "required": true,
                  "label": "交付单元总数"
                }
              }
            },
            "summary": {
              "title": "反馈分流摘要",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "groups": {
              "title": "反馈工作组",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "workType": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "reply",
                    "historical_correction",
                    "report_correction",
                    "bug",
                    "behavior_change",
                    "scope_addition",
                    "technical_change",
                    "learning_only"
                  ],
                  "label": "工作类型"
                },
                "title": {
                  "type": "string",
                  "label": "标题"
                },
                "reason": {
                  "type": "string",
                  "required": true,
                  "label": "原因"
                },
                "response": {
                  "type": "string",
                  "label": "回复"
                },
                "commentIds": {
                  "type": "array",
                  "itemType": "string",
                  "required": true,
                  "minItems": 1,
                  "label": "评论 ID"
                },
                "affectedDeliveryUnits": {
                  "type": "array",
                  "required": true,
                  "label": "受影响交付单元的数字序号字符串，如 ['1']；不要填标题或 unit key"
                },
                "acceptance": {
                  "type": "array",
                  "itemType": "string",
                  "required": true,
                  "label": "逐项完整验收语义字符串；不要使用对象或只填 key"
                }
              }
            },
            "answer-review": {
              "title": "澄清答案复查",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            }
          }
        }
      },
      "phases": {
        "inputs": {
          "type": "builtin",
          "builtin": "feedback-triage-inputs"
        },
        "clarification_proposal": {
          "type": "builtin",
          "builtin": "decision-proposal"
        },
        "clarification_resolution": {
          "type": "builtin",
          "builtin": "decision-resolution"
        },
        "answer_review": {
          "type": "builtin",
          "builtin": "decision-answer-review",
          "artifacts": [
            "feedback.answer-review"
          ]
        },
        "grouping": {
          "type": "artifact",
          "artifacts": [
            "feedback.summary",
            "feedback.groups"
          ],
          "instructions": "对当前批次做完整分流，并消费全部已关闭澄清。每条冻结评论必须且只能属于一个稳定 group key；直接回复和历史更正写 response，任何会产生后续工作的类型必须提供标题和可验证 acceptance。"
        },
        "finalize": {
          "type": "builtin",
          "builtin": "feedback-triage-finalize"
        }
      }
    }),
    define("feedback-verify", {
      "version": 1,
      "id": "feedback-verify",
      "agent": "feedback-agent",
      "artifacts": {
        "feedback": {
          "type": "builtin",
          "title": "反馈验证",
          "blocks": {
            "target": {
              "title": "冻结反馈目标",
              "cardinality": "one",
              "format": "yaml",
              "writable": false,
              "required": true,
              "fields": {
                "commentId": {
                  "type": "string",
                  "required": true,
                  "label": "评论 ID"
                },
                "groupId": {
                  "type": "string",
                  "required": true,
                  "label": "工作组 ID"
                }
              }
            },
            "summary": {
              "title": "反馈验证摘要",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "evidence": {
              "title": "独立反馈证据",
              "cardinality": "many",
              "format": "text",
              "required": true
            },
            "conclusion": {
              "title": "反馈验证结论",
              "cardinality": "one",
              "format": "yaml",
              "required": true,
              "fields": {
                "verdict": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "resolved",
                    "reopened"
                  ],
                  "label": "验证结论"
                },
                "reason": {
                  "type": "string",
                  "required": true,
                  "label": "原因"
                }
              }
            }
          }
        }
      },
      "phases": {
        "inputs": {
          "type": "builtin",
          "builtin": "feedback-verify-inputs"
        },
        "verify": {
          "type": "artifact",
          "artifacts": [
            "feedback.summary",
            "feedback.evidence",
            "feedback.conclusion"
          ],
          "instructions": "只验证当前冻结评论。使用独立观察证据判断要求是否满足；resolved 表示已满足，reopened 表示仍未满足并将形成新的前向反馈批次。不要修改历史交付物或验证其他评论。"
        },
        "finalize": {
          "type": "builtin",
          "builtin": "feedback-verify-finalize"
        }
      }
    })
    ];
  },

};
