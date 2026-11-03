/**
 * 需求意图：收敛问题、参与者、目标与成功结果。
 *
 * 给维护同事：OMP 原生入口是 /idea-context-agent，专业 Prompt 在同目录 idea-context-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "idea-context-agent",

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
    define("idea-context", {
      "version": 1,
      "id": "idea-context",
      "agent": "idea-context-agent",
      "artifacts": {
        "requirement-intent": {
          "type": "builtin",
          "title": "需求意图简报",
          "blocks": {
            "discovery": {
              "title": "意图调查",
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
            "problem": {
              "title": "问题与背景",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "actors": {
              "title": "目标参与者",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "name": {
                  "type": "string",
                  "required": true,
                  "label": "参与者"
                },
                "role": {
                  "type": "string",
                  "required": true,
                  "label": "角色"
                },
                "need": {
                  "type": "string",
                  "required": true,
                  "label": "需求"
                }
              }
            },
            "goals": {
              "title": "业务目标",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "目标"
                },
                "source": {
                  "type": "string",
                  "required": true,
                  "label": "来源"
                }
              }
            },
            "success": {
              "title": "成功结果",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
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
            "constraints": {
              "title": "硬性约束",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "约束"
                },
                "source": {
                  "type": "string",
                  "required": true,
                  "label": "来源"
                }
              }
            },
            "authorities": {
              "title": "权威输入",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "权威输入"
                },
                "source": {
                  "type": "string",
                  "required": true,
                  "label": "来源"
                }
              }
            },
            "exclusions": {
              "title": "排除项",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "排除项"
                }
              }
            },
            "assumptions": {
              "title": "已确认假设",
              "cardinality": "many",
              "format": "yaml",
              "fields": {
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "假设"
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
        "discovery": {
          "type": "artifact",
          "artifacts": [
            "requirement-intent.discovery"
          ],
          "instructions": "调查原始想法和全部可获得资料，区分事实、假设与未知项，并找出会改变需求意图的歧义。能够通过现有资料查明的事实不要转交用户，也不要提前选择业务方案。"
        },
        "research": {
          "type": "artifact",
          "artifacts": [
            "requirement-intent.research-sources"
          ],
          "instructions": "调查领域术语、标准、法规、官方定义和参考资料。只登记真实查阅且会影响需求意图理解的来源、适用性、局限与置信度；外部惯例不能替代用户目标。"
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
            "requirement-intent.answer-review"
          ]
        },
        "synthesis": {
          "type": "artifact",
          "artifacts": [
            "requirement-intent.problem",
            "requirement-intent.actors",
            "requirement-intent.goals",
            "requirement-intent.success",
            "requirement-intent.constraints",
            "requirement-intent.authorities",
            "requirement-intent.exclusions",
            "requirement-intent.assumptions"
          ],
          "instructions": "只根据原始想法、可靠事实和已关闭决策登记问题、目标参与者、业务目标、成功结果、硬约束、权威输入、排除项与已确认假设。每个稳定条目使用可追溯来源，不要隐藏新的产品决定。"
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
