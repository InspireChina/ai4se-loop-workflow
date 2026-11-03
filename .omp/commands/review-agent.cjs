/**
 * 结卡对账：核对交付事实、证据与最终输出。
 *
 * 给维护同事：OMP 原生入口是 /review-agent，专业 Prompt 在同目录 review-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "review-agent",

  // 角色级校验使用真实函数；错误数组由当前阶段的完成门禁消费。
  /** 校验当前阶段的业务完成条件。
   * context.names 只列出本阶段请求的校验；不要把其他阶段的门禁提前套用。
   * artifacts / decisions 是当前草稿投影，tools 来自同目录共享运行库。
   * 返回错误消息数组；非空会阻止阶段完成。规则调整主要修改下面的条件。 */
  validate({ db, draft, names, artifacts, decisions, tools }) {
    const { reviewInputErrors, reviewReconciliationErrors, reviewAssessmentErrors, reviewOutputErrors } = tools;
    const errors = [];
    // 先确认被冻结的对账对象及证据来源。
    if (names.includes('review-inputs')) {
        errors.push(...reviewInputErrors(db, draft, artifacts));
    }
    // 每个对账结论必须能追溯到冻结事实和证据。
    if (names.includes('review-reconciliation')) {
        errors.push(...reviewReconciliationErrors(artifacts));
    }
    // 复查交付与独立验证是否支持当前结卡判断。
    if (names.includes('review-assessment')) {
        errors.push(...reviewAssessmentErrors(artifacts));
    }
    // 检查最终报告结构与结论，不能靠空报告通过结卡。
    if (names.includes('review-output')) {
        errors.push(...reviewOutputErrors(artifacts));
    }

    return errors;
  },

  /** 把当前草稿组装为结构化 AgentResult，不直接决定下一角色。
   * needsInput=true 表示暂停等待已登记的输入，不是检查通过。
   * 正常分支只能使用已记录的事实和证据；结果仍需通过引擎 Schema 与应用规则。 */
  result({ db, draft, needsInput, tools }) {
    const { reviewExecutionForDraft, assertReviewExecutionCurrent, reviewState, decodedArtifacts, artifactRows, agentResultSchema, parse, bounded, reviewTaskHeader, renderReviewArtifact } = tools;
    if (needsInput)
        throw new Error('Review 命令链不能请求问题或 runtime input');
    const execution = reviewExecutionForDraft(db, draft);
    assertReviewExecutionCurrent(db, draft, execution);
    const state = reviewState(decodedArtifacts(artifactRows(db, draft.draft_id)));
    if (state.gaps.length) {
        return agentResultSchema.parse({
            outcome: 'completed',
            summary: `发现 ${state.gaps.length} 个结卡缺口，需要前向追加交付单元后重新结卡。`,
            verdict: 'closure_gap',
            closureGaps: state.gaps.map((gap) => ({
                key: gap.key,
                subject: gap.subjectRef,
                kind: gap.kind,
                reason: gap.reason,
                boundary: gap.boundary,
            })),
            closureGapUnits: state.units.map((unit) => ({
                key: unit.key,
                title: unit.title,
                actor: unit.actor,
                trigger: unit.trigger,
                observableOutcome: unit.observableOutcome,
                acceptance: unit.acceptance,
                gapKeys: unit.gapKeys,
                dependsOn: unit.dependsOn,
            })),
            questions: [],
            runtimeInputs: [],
        });
    }
    const outcome = state.sections.find((section) => section.kind === 'outcome')?.content || '最终事实对账完成。';
    return agentResultSchema.parse({
        outcome: 'completed',
        summary: bounded(outcome, '结卡摘要', 4000),
        artifact: {
            title: `${reviewTaskHeader(db, draft.task_id).title} · 结卡报告`,
            content: renderReviewArtifact(db, draft),
        },
        verdict: 'report_ready',
        questions: [],
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
    define("review", {
      "version": 1,
      "id": "review",
      "agent": "review-agent",
      "artifacts": {
        "review": {
          "type": "builtin",
          "title": "结卡报告",
          "blocks": {
            "subjects": {
              "title": "冻结结卡主题",
              "cardinality": "many",
              "format": "yaml",
              "writable": false,
              "required": true,
              "fields": {
                "kind": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "intent",
                    "target",
                    "impact",
                    "acceptance",
                    "delivery_unit",
                    "feedback_acceptance"
                  ],
                  "label": "主题类型"
                },
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "内容"
                },
                "sourceRef": {
                  "type": "string",
                  "label": "来源引用"
                },
                "contractRef": {
                  "type": "string",
                  "label": "契约引用"
                },
                "storyIndex": {
                  "type": "string",
                  "label": "交付单元序号"
                }
              }
            },
            "evidence-sources": {
              "title": "冻结证据来源",
              "cardinality": "many",
              "format": "yaml",
              "writable": false,
              "required": true,
              "fields": {
                "ref": {
                  "type": "string",
                  "required": true,
                  "label": "证据引用"
                },
                "kind": {
                  "type": "string",
                  "required": true,
                  "label": "证据类型"
                },
                "status": {
                  "type": "string",
                  "required": true,
                  "label": "状态"
                },
                "revision": {
                  "type": "string",
                  "required": true,
                  "label": "版本"
                },
                "fingerprint": {
                  "type": "string",
                  "required": true,
                  "label": "指纹"
                },
                "independentTest": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "yes",
                    "no"
                  ],
                  "label": "独立测试"
                }
              }
            },
            "meta": {
              "title": "冻结审查元数据",
              "cardinality": "one",
              "format": "yaml",
              "writable": false,
              "required": true,
              "fields": {
                "mode": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "closure",
                    "report_correction"
                  ],
                  "label": "审查模式"
                },
                "totalStories": {
                  "type": "string",
                  "required": true,
                  "label": "交付单元总数"
                },
                "reviewRevision": {
                  "type": "string",
                  "required": true,
                  "label": "报告版本"
                },
                "reviewDocumentId": {
                  "type": "string",
                  "label": "报告文档 ID"
                }
              }
            },
            "reconciliations": {
              "title": "最终事实对账",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "subjectRef": {
                  "type": "string",
                  "required": true,
                  "label": "冻结主题 key（从 FROZEN REVIEW SUBJECTS 逐字复制，不追加解释）"
                },
                "result": {
                  "type": "string",
                  "required": true,
                  "label": "对账结论"
                },
                "evidenceRefs": {
                  "type": "array",
                  "itemType": "string",
                  "required": true,
                  "minItems": 1,
                  "label": "冻结证据 ref 数组（从 FROZEN EVIDENCE SOURCES 逐字复制，不追加版本、括号或解释）"
                }
              }
            },
            "gaps": {
              "title": "结卡缺口",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "subjectRef": {
                  "type": "string",
                  "required": true,
                  "label": "主题引用"
                },
                "kind": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "missing_evidence",
                    "fact_conflict",
                    "unresolved_obligation"
                  ],
                  "label": "缺口类型"
                },
                "reason": {
                  "type": "string",
                  "required": true,
                  "label": "原因"
                },
                "boundary": {
                  "type": "string",
                  "required": true,
                  "label": "影响边界"
                }
              }
            },
            "assessment": {
              "title": "结卡评估",
              "cardinality": "one",
              "format": "yaml",
              "required": true,
              "fields": {
                "summary": {
                  "type": "string",
                  "required": true,
                  "label": "评估摘要"
                },
                "evidenceBoundary": {
                  "type": "string",
                  "required": true,
                  "label": "证据边界"
                },
                "residualRisk": {
                  "type": "string",
                  "label": "残余风险"
                }
              }
            },
            "report-sections": {
              "title": "结卡报告章节",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "kind": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "outcome",
                    "scope",
                    "decisions",
                    "implementation",
                    "verification",
                    "deviations",
                    "risks",
                    "feedback"
                  ],
                  "label": "章节类型"
                },
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "内容"
                }
              }
            },
            "forward-units": {
              "title": "前向交付单元",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "title": {
                  "type": "string",
                  "required": true,
                  "label": "标题"
                },
                "actor": {
                  "type": "string",
                  "required": true,
                  "label": "参与者"
                },
                "trigger": {
                  "type": "string",
                  "required": true,
                  "label": "触发条件"
                },
                "observableOutcome": {
                  "type": "string",
                  "required": true,
                  "label": "可观察结果"
                },
                "acceptance": {
                  "type": "string",
                  "required": true,
                  "label": "验收语义"
                },
                "gapKeys": {
                  "type": "array",
                  "itemType": "string",
                  "required": true,
                  "minItems": 1,
                  "label": "缺口 Key"
                },
                "dependsOn": {
                  "type": "array",
                  "itemType": "string",
                  "required": true,
                  "label": "前置单元"
                }
              }
            }
          }
        }
      },
      "phases": {
        "inputs": {
          "type": "builtin",
          "builtin": "review-inputs"
        },
        "fact_reconciliation": {
          "type": "builtin",
          "builtin": "review-reconciliation",
          "artifacts": [
            "review.reconciliations",
            "review.gaps"
          ]
        },
        "closure_assessment": {
          "type": "artifact",
          "artifacts": [
            "review.assessment"
          ],
          "instructions": "综合全部最终事实，判断原始需求是否已闭环。说明结论覆盖的冻结证据边界；仍会否定结卡的事项必须回退 fact_reconciliation 登记 gap，不能只写成残余风险。"
        },
        "closure_output": {
          "type": "builtin",
          "builtin": "review-output",
          "artifacts": [
            "review.report-sections",
            "review.forward-units"
          ]
        },
        "finalize": {
          "type": "builtin",
          "builtin": "review-finalize"
        }
      }
    })
    ];
  },

};
