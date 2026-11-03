/**
 * 业务方案：场景、流程、规则与上游缺口。
 *
 * 给维护同事：OMP 原生入口是 /business-design-agent，专业 Prompt 在同目录 business-design-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "business-design-agent",

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
    define("business-design", {
      "version": 1,
      "id": "business-design",
      "agent": "business-design-agent",
      "artifacts": {
        "business-solution": {
          "type": "builtin",
          "title": "业务方案",
          "blocks": {
            "exploration": {
              "title": "业务探索",
              "cardinality": "one",
              "format": "markdown",
              "required": true,
              "render": false
            },
            "research-sources": {
              "title": "调研依据",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "claim": {
                  "type": "string",
                  "required": true,
                  "label": "调研结论"
                },
                "sourceTitle": {
                  "type": "string",
                  "required": true,
                  "label": "来源"
                },
                "sourceUrl": {
                  "type": "string",
                  "required": true,
                  "label": "链接"
                },
                "applicability": {
                  "type": "string",
                  "required": true,
                  "label": "适用范围"
                },
                "limitations": {
                  "type": "string",
                  "required": true,
                  "label": "局限"
                },
                "confidence": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "high",
                    "medium",
                    "low"
                  ],
                  "label": "置信度"
                }
              }
            },
            "answer-review": {
              "title": "答案复查",
              "cardinality": "one",
              "format": "markdown",
              "required": true,
              "render": false
            },
            "upstream-gaps": {
              "title": "需求意图缺口",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "reason": {
                  "type": "string",
                  "required": true,
                  "label": "缺口"
                },
                "evidence": {
                  "type": "string",
                  "required": true,
                  "label": "证据"
                }
              }
            },
            "summary": {
              "title": "方案摘要",
              "cardinality": "one",
              "format": "markdown"
            },
            "actors": {
              "title": "参与者与职责",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "name": {
                  "type": "string",
                  "required": true,
                  "label": "参与者"
                },
                "responsibility": {
                  "type": "string",
                  "required": true,
                  "label": "职责"
                }
              }
            },
            "scenarios": {
              "title": "主流程与异常场景",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "kind": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "main",
                    "exception",
                    "recovery"
                  ],
                  "label": "类型"
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
                "outcome": {
                  "type": "string",
                  "required": true,
                  "label": "结果"
                }
              }
            },
            "flows": {
              "title": "业务流程",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "scenario": {
                  "type": "string",
                  "required": true,
                  "label": "场景"
                },
                "action": {
                  "type": "string",
                  "required": true,
                  "label": "行动"
                },
                "result": {
                  "type": "string",
                  "required": true,
                  "label": "结果"
                }
              }
            },
            "rules": {
              "title": "业务规则",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "规则"
                },
                "rationale": {
                  "type": "string",
                  "required": true,
                  "label": "原因"
                }
              }
            },
            "states": {
              "title": "业务状态",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "state": {
                  "type": "string",
                  "required": true,
                  "label": "状态"
                },
                "meaning": {
                  "type": "string",
                  "required": true,
                  "label": "含义"
                },
                "transitions": {
                  "type": "array",
                  "label": "状态转换"
                }
              }
            },
            "scope": {
              "title": "范围",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "direction": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "included",
                    "excluded"
                  ],
                  "label": "范围"
                },
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "内容"
                }
              }
            },
            "success": {
              "title": "成功结果",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "outcome": {
                  "type": "string",
                  "required": true,
                  "label": "成功结果"
                },
                "measure": {
                  "type": "string",
                  "required": true,
                  "label": "衡量方式"
                }
              }
            },
            "dependencies": {
              "title": "业务依赖",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "依赖"
                },
                "source": {
                  "type": "string",
                  "required": true,
                  "label": "来源"
                }
              }
            }
          }
        }
      },
      "phases": {
        "exploration": {
          "type": "artifact",
          "artifacts": [
            "business-solution.exploration"
          ],
          "instructions": "基于已确认需求意图探索完整业务空间，主动寻找主流程、异常、恢复、规则冲突、权限边界和候选方案代价。只提出事实与分叉，不在本阶段暗中关闭决定，也不检查技术实现。"
        },
        "research": {
          "type": "artifact",
          "artifacts": [
            "business-solution.research-sources"
          ],
          "instructions": "调查可借鉴的业务模式、规则、异常与失败模式，并登记来源的适用性和局限。外部最佳实践只能丰富选项，不能自动成为用户要求。"
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
            "business-solution.answer-review"
          ]
        },
        "solution": {
          "type": "artifact",
          "artifacts": [
            "business-solution.upstream-gaps",
            "business-solution.summary",
            "business-solution.actors",
            "business-solution.scenarios",
            "business-solution.flows",
            "business-solution.rules",
            "business-solution.states",
            "business-solution.scope",
            "business-solution.success",
            "business-solution.dependencies"
          ],
          "instructions": "没有上游缺口时，根据 Active Decision Path 登记唯一业务方案，至少覆盖摘要、参与者、主异常场景、流程、规则、范围和成功结果；状态与依赖按实际需要登记。若需求意图仍有实质缺口，使用稳定 key 登记 upstream-gaps，并停止编造方案内容。"
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
