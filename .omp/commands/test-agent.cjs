/**
 * 独立验证：冻结计划、执行场景并形成独立结论。
 *
 * 给维护同事：OMP 原生入口是 /test-agent，专业 Prompt 在同目录 test-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "test-agent",

  // 角色级校验使用真实函数；错误数组由当前阶段的完成门禁消费。
  /** 校验当前阶段的业务完成条件。
   * context.names 只列出本阶段请求的校验；不要把其他阶段的门禁提前套用。
   * artifacts / decisions 是当前草稿投影，tools 来自同目录共享运行库。
   * 返回错误消息数组；非空会阻止阶段完成。规则调整主要修改下面的条件。 */
  validate({ db, draft, names, artifacts, decisions, tools }) {
    const { verificationState, verificationPlanErrors, verificationExecutionErrors, runtimeInputRows } = tools;
    const errors = [];
    // 验证必须基于冻结来源，不能以 Dev 自述替代验收输入。
    if (names.includes('verification-inputs') && !verificationState(artifacts).sources.length) {
        errors.push('验证命令链缺少冻结验证输入');
    }
    // 每个冻结目标需要覆盖场景与可观察的预期。
    if (names.includes('verification-plan')) {
        errors.push(...verificationPlanErrors(artifacts));
    }
    // 检查场景实际结果、独立证据与失败责任分类。
    if (names.includes('verification-execution')) {
        errors.push(...verificationExecutionErrors(artifacts, runtimeInputRows(db, draft)));
    }
    // blocked 必须先解决，证据复核后才能形成最终验证结论。
    if (names.includes('verification-complete')) {
        const verification = verificationState(artifacts);
        errors.push(...verificationExecutionErrors(artifacts, runtimeInputRows(db, draft)));
        if (!verification.review?.summary.trim())
            errors.push('缺少证据复核摘要');
        if (verification.results.some((result) => result.status === 'blocked')) {
            errors.push('仍有 blocked 场景，不能提交独立验证结论');
        }
    }

    return errors;
  },

  /** 把当前草稿组装为结构化 AgentResult，不直接决定下一角色。
   * needsInput=true 表示暂停等待已登记的输入，不是检查通过。
   * 正常分支只能使用已记录的事实和证据；结果仍需通过引擎 Schema 与应用规则。 */
  result({ db, draft, needsInput, tools }) {
    const { runtimeInputRows, agentResultSchema, parse, renderVerificationArtifact, verificationState, decodedArtifacts, artifactRows } = tools;
    const inputs = runtimeInputRows(db, draft).filter((input) => !input.answer);
    if (needsInput) {
        return agentResultSchema.parse({
            outcome: 'needs_input',
            summary: `独立验证缺少运行资源或信息：${inputs.map((input) => input.title).join('、')}`,
            artifact: { title: '独立验证进行中', content: renderVerificationArtifact(db, draft) },
            runtimeInputs: inputs.map((input) => ({
                key: input.request_key, title: input.title, question: input.question,
                why: input.why, recommendation: input.recommendation,
            })),
        });
    }
    const state = verificationState(decodedArtifacts(artifactRows(db, draft.draft_id)));
    const failed = state.results.filter((result) => result.status === 'failed');
    const specificationFailures = failed.filter((result) => result.failureKind === 'specification').length;
    const implementationFailures = failed.length - specificationFailures;
    const failureSummary = [
        specificationFailures ? `${specificationFailures} 个场景存在规格矛盾` : '',
        implementationFailures ? `${implementationFailures} 个场景存在实现偏差` : '',
    ].filter(Boolean).join('；');
    const verdict = failed.length ? 'failed' : 'passed';
    const failureKind = failed.some((result) => result.failureKind === 'specification')
        ? 'specification'
        : failed.length
            ? 'implementation'
            : undefined;
    return agentResultSchema.parse({
        outcome: 'completed',
        summary: verdict === 'passed'
            ? `独立验证通过：${state.results.length} 个场景全部符合冻结交付契约`
            : `独立验证失败：${failureSummary}`,
        artifact: { title: '独立验证报告', content: renderVerificationArtifact(db, draft) },
        verdict,
        ...(failureKind ? {
            failureKind,
            rewindTo: failureKind === 'specification' ? 'analysis' : 'dev',
            rewindDeliveryUnit: draft.story_index || undefined,
        } : {}),
        tests: state.scenarios.map((scenario) => {
            const result = state.results.find((candidate) => candidate.key === scenario.key);
            return {
                command: `[${scenario.channel}] ${scenario.title}`,
                passed: result.status === 'passed',
                summary: `${result.evidence}${result.actualBehavior ? `；实际：${result.actualBehavior}` : ''}`,
            };
        }),
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
    define("verification", {
      "version": 1,
      "id": "verification",
      "agent": "test-agent",
      "artifacts": {
        "verification": {
          "type": "builtin",
          "title": "独立验证报告",
          "blocks": {
            "sources": {
              "title": "冻结验证输入",
              "cardinality": "many",
              "format": "yaml",
              "writable": false,
              "required": true,
              "fields": {
                "kind": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "acceptance",
                    "focus",
                    "guardrail",
                    "recovery"
                  ],
                  "label": "输入类型"
                },
                "description": {
                  "type": "string",
                  "required": true,
                  "label": "描述"
                },
                "oracle": {
                  "type": "string",
                  "required": true,
                  "label": "验证 Oracle"
                },
                "sourceRef": {
                  "type": "string",
                  "required": true,
                  "label": "来源引用"
                }
              }
            },
            "scenarios": {
              "title": "验证场景",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "channel": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "frontend",
                    "api"
                  ],
                  "label": "验证渠道"
                },
                "title": {
                  "type": "string",
                  "required": true,
                  "label": "场景标题"
                },
                "setup": {
                  "type": "string",
                  "required": true,
                  "label": "前置条件"
                },
                "steps": {
                  "type": "string",
                  "required": true,
                  "label": "验证步骤"
                },
                "expected": {
                  "type": "string",
                  "required": true,
                  "label": "预期结果"
                },
                "coverageRefs": {
                  "type": "array",
                  "itemType": "string",
                  "required": true,
                  "minItems": 1,
                  "label": "覆盖引用"
                }
              }
            },
            "results": {
              "title": "验证结果",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
              "fields": {
                "status": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "passed",
                    "failed",
                    "blocked"
                  ],
                  "label": "验证结果"
                },
                "failureKind": {
                  "type": "enum",
                  "values": [
                    "implementation",
                    "specification",
                    "environment",
                    "inconclusive"
                  ],
                  "label": "失败归因"
                },
                "evidence": {
                  "type": "string",
                  "required": true,
                  "label": "证据"
                },
                "actualBehavior": {
                  "type": "string",
                  "label": "实际行为"
                }
              }
            },
            "evidence-review": {
              "title": "证据复核",
              "cardinality": "one",
              "format": "yaml",
              "required": true,
              "fields": {
                "summary": {
                  "type": "string",
                  "required": true,
                  "label": "复核摘要"
                },
                "residualRisk": {
                  "type": "string",
                  "label": "残余风险"
                }
              }
            }
          }
        }
      },
      "phases": {
        "inputs": {
          "type": "builtin",
          "builtin": "verification-inputs"
        },
        "plan": {
          "type": "builtin",
          "builtin": "verification-plan",
          "artifacts": [
            "verification.scenarios"
          ]
        },
        "execute": {
          "type": "builtin",
          "builtin": "verification-execution",
          "artifacts": [
            "verification.scenarios",
            "verification.results"
          ]
        },
        "evidence_review": {
          "type": "artifact",
          "artifacts": [
            "verification.evidence-review"
          ],
          "instructions": "逐项复核 Expected、Actual、独立证据和 failureKind 是否一致。人工观察必须明确来源；证据不足、分类错误或仍会改变结论时回退 execute，不能把它降格为残余风险。"
        },
        "finalize": {
          "type": "builtin",
          "builtin": "verification-finalize"
        }
      }
    })
    ];
  },

};
