/**
 * 问题复现：区分已复现、未复现与待补事实。
 *
 * 给维护同事：OMP 原生入口是 /repro-agent，专业 Prompt 在同目录 repro-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "repro-agent",

  // 角色级校验使用真实函数；错误数组由当前阶段的完成门禁消费。
  /** 校验当前阶段的业务完成条件。
   * context.names 只列出本阶段请求的校验；不要把其他阶段的门禁提前套用。
   * artifacts / decisions 是当前草稿投影，tools 来自同目录共享运行库。
   * 返回错误消息数组；非空会阻止阶段完成。规则调整主要修改下面的条件。 */
  validate({ db, draft, names, artifacts, decisions, tools }) {
    const {  } = tools;
    const errors = [];
    // 只有未复现分支可暂停请求补充复现事实。
    if (names.includes('reproduction-alignment')) {
        const verdict = artifacts.find((artifact) => artifact.block_id === 'verdict')?.value;
        const pending = decisions.filter((decision) => decision.status === 'needs_user_input');
        if (pending.length && verdict?.status !== 'not_reproduced') {
            errors.push('只有 not_reproduced 结论可以请求用户补充复现事实');
        }
    }
    // 完成复现必须有真实步骤与证据，不能用未复现结论直接提交。
    if (names.includes('reproduction-complete')) {
        const verdict = artifacts.find((artifact) => artifact.block_id === 'verdict')?.value;
        if (verdict?.status !== 'reproduced')
            errors.push('只有 reproduced 结论可以完成问题复现');
        for (const block of ['steps', 'evidence']) {
            if (!artifacts.some((artifact) => artifact.block_id === block))
                errors.push(`问题复现至少需要一项 ${block}`);
        }
    }

    return errors;
  },

  /** 把当前草稿组装为结构化 AgentResult，不直接决定下一角色。
   * needsInput=true 表示暂停等待已登记的输入，不是检查通过。
   * 正常分支只能使用已记录的事实和证据；结果仍需通过引擎 Schema 与应用规则。 */
  result({ db, draft, needsInput, tools }) {
    const { definitionForDraft, decodedDecisions, decisionRows, renderReproductionArtifact, decisionQuestions, agentResultSchema, parse } = tools;
    const definition = definitionForDraft(draft);
    const decisions = decodedDecisions(decisionRows(db, draft.draft_id), definition);
    const artifact = { title: needsInput ? '问题复现记录' : '问题复现证据', content: renderReproductionArtifact(db, draft) };
    if (needsInput) {
        const questions = decisionQuestions(decisions);
        return agentResultSchema.parse({
            outcome: 'needs_input',
            summary: `当前条件未能确认问题，仍需用户补充 ${questions.length} 项复现事实`,
            artifact,
            reproVerdict: 'not_reproduced',
            questions,
        });
    }
    return agentResultSchema.parse({
        outcome: 'completed',
        summary: '问题已在明确条件下稳定复现，并形成可供交付规划使用的证据',
        artifact,
        reproVerdict: 'reproduced',
        route: 'plan',
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
    define("reproduction", {
      "version": 1,
      "id": "reproduction",
      "agent": "repro-agent",
      "artifacts": {
        "reproduction": {
          "type": "builtin",
          "title": "问题复现证据",
          "blocks": {
            "verdict": {
              "title": "复现结论",
              "cardinality": "one",
              "format": "yaml",
              "required": true,
              "fields": {
                "status": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "reproduced",
                    "not_reproduced"
                  ],
                  "label": "复现状态"
                },
                "expectedBehavior": {
                  "type": "string",
                  "required": true,
                  "label": "预期行为"
                },
                "actualBehavior": {
                  "type": "string",
                  "required": true,
                  "label": "实际行为"
                },
                "environment": {
                  "type": "string",
                  "required": true,
                  "label": "复现环境"
                },
                "stability": {
                  "type": "string",
                  "required": true,
                  "label": "稳定性"
                },
                "impactScope": {
                  "type": "string",
                  "required": true,
                  "label": "影响范围"
                }
              }
            },
            "steps": {
              "title": "复现步骤",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "action": {
                  "type": "string",
                  "required": true,
                  "label": "操作"
                },
                "expected": {
                  "type": "string",
                  "required": true,
                  "label": "预期结果"
                },
                "actual": {
                  "type": "string",
                  "required": true,
                  "label": "实际结果"
                }
              }
            },
            "evidence": {
              "title": "复现证据",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "kind": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "log",
                    "screenshot",
                    "command",
                    "observation"
                  ],
                  "label": "证据类型"
                },
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "证据内容"
                },
                "source": {
                  "type": "string",
                  "required": true,
                  "label": "证据来源"
                }
              }
            },
            "hypotheses": {
              "title": "调查方向",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "status": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "suspected",
                    "excluded"
                  ],
                  "label": "状态"
                },
                "statement": {
                  "type": "string",
                  "required": true,
                  "label": "假设"
                },
                "evidence": {
                  "type": "string",
                  "required": true,
                  "label": "证据"
                }
              }
            },
            "answer-review": {
              "title": "对齐答案复查",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            }
          }
        }
      },
      "phases": {
        "investigation": {
          "type": "artifact",
          "artifacts": [
            "reproduction.verdict",
            "reproduction.steps",
            "reproduction.evidence",
            "reproduction.hypotheses"
          ],
          "instructions": "建立最小充分的复现记录。Expected 只陈述报告或既有规范中的候选预期，Actual 只陈述当前条件下观察到的事实；明确环境、稳定性、最小影响范围、可重复步骤和可定位证据。无法确认不等于问题不存在，根因假设只用于指导调查，不得变成实现方案。"
        },
        "alignment_proposal": {
          "type": "builtin",
          "builtin": "decision-proposal"
        },
        "alignment_resolution": {
          "type": "builtin",
          "builtin": "decision-resolution"
        },
        "answer_review": {
          "type": "builtin",
          "builtin": "decision-answer-review",
          "artifacts": [
            "reproduction.answer-review"
          ]
        },
        "finalize": {
          "type": "builtin",
          "builtin": "reproduction-finalize"
        }
      }
    })
    ];
  },

};
