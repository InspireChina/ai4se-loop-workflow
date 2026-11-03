/**
 * 交付规划：把冻结来源映射为独立交付单元。
 *
 * 给维护同事：OMP 原生入口是 /story-splitter-agent，专业 Prompt 在同目录 story-splitter-agent.md。
 * 本文件是实际运行源码，不是生成产物；保存后下一次加载直接生效，无须重新 build。
 * 常见修改：业务校验看 validate，交付输出看 result，步骤/字段看 describe。
 * 公共协议和数据操作看 workflow/command-chain-runtime.cjs；接口说明见 docs/command-script-api.md。
 */
module.exports = {
  // 调度接口版本与逻辑角色身份；更改业务实现时保持这两个绑定。
  apiVersion: 1,
  agent: "story-splitter-agent",

  // 角色级校验使用真实函数；错误数组由当前阶段的完成门禁消费。
  /** 校验当前阶段的业务完成条件。
   * context.names 只列出本阶段请求的校验；不要把其他阶段的门禁提前套用。
   * artifacts / decisions 是当前草稿投影，tools 来自同目录共享运行库。
   * 返回错误消息数组；非空会阻止阶段完成。规则调整主要修改下面的条件。 */
  validate({ db, draft, names, artifacts, decisions, tools }) {
    const { deliveryPlanState, deliveryPlanErrors } = tools;
    const errors = [];
    // 必须存在本轮冻结的规划来源，不能凭空规划交付单元。
    if (names.includes('delivery-plan-inputs') && !deliveryPlanState(artifacts).sources.length) {
        errors.push('交付计划缺少冻结规划输入');
    }
    // 核对来源覆盖、交付单元内容与依赖关系。
    if (names.includes('delivery-plan-complete')) {
        errors.push(...deliveryPlanErrors(db, draft, artifacts));
    }

    return errors;
  },

  /** 把当前草稿组装为结构化 AgentResult，不直接决定下一角色。
   * needsInput=true 表示暂停等待已登记的输入，不是检查通过。
   * 正常分支只能使用已记录的事实和证据；结果仍需通过引擎 Schema 与应用规则。 */
  result({ db, draft, needsInput, tools }) {
    const { deliveryPlanState, decodedArtifacts, artifactRows, deliveryUnitContractSchema, parse, agentResultSchema } = tools;
    const state = deliveryPlanState(decodedArtifacts(artifactRows(db, draft.draft_id)));
    const sourceByKey = new Map(state.sources.map((source) => [source.key, source]));
    const deliveryUnits = state.units.map((unit) => deliveryUnitContractSchema.parse({
        key: unit.key,
        title: unit.title,
        actor: unit.actor,
        trigger: unit.trigger,
        observableOutcome: unit.observableOutcome,
        acceptance: unit.acceptance,
        sourceRefs: unit.sourceRefs.map((key) => sourceByKey.get(key)).filter(Boolean),
        dependsOn: unit.dependsOn,
    }));
    const artifact = [
        '# 交付计划', '',
        '## 拆分依据', '', state.rationale, '',
        '## 整体覆盖', '', state.coverage, '',
        ...(state.ordering ? ['## 排序与依赖', '', state.ordering, ''] : []),
        '## 交付单元', '',
        ...deliveryUnits.flatMap((unit, index) => [
            `### ${index + 1}. ${unit.title}`, '',
            `- Key：${unit.key}`,
            `- 参与者：${unit.actor}`,
            `- 触发条件：${unit.trigger}`,
            `- 用户可观察结果：${unit.observableOutcome}`,
            `- 验收语义：${unit.acceptance}`,
            `- 冻结来源：${unit.sourceRefs.map((source) => source.key).join('、')}`,
            `- 前置单元：${unit.dependsOn.join('、') || '无'}`, '',
        ]),
    ].join('\n');
    return agentResultSchema.parse({
        outcome: 'completed',
        summary: `已规划 ${deliveryUnits.length} 个可独立验收的交付单元`,
        artifact: { title: '交付计划', content: artifact },
        deliveryUnits,
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
    define("delivery-plan", {
      "version": 1,
      "id": "delivery-plan",
      "agent": "story-splitter-agent",
      "artifacts": {
        "delivery-plan": {
          "type": "builtin",
          "title": "交付计划",
          "blocks": {
            "sources": {
              "title": "冻结规划输入",
              "cardinality": "many",
              "format": "yaml",
              "writable": false,
              "required": true,
              "fields": {
                "kind": {
                  "type": "enum",
                  "required": true,
                  "values": [
                    "change",
                    "preserve",
                    "technical",
                    "acceptance"
                  ],
                  "label": "输入类型"
                },
                "content": {
                  "type": "string",
                  "required": true,
                  "label": "内容"
                },
                "sourceRef": {
                  "type": "string",
                  "required": true,
                  "label": "来源引用"
                }
              }
            },
            "rationale": {
              "title": "拆分依据",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "units": {
              "title": "交付单元",
              "cardinality": "many",
              "format": "yaml",
              "required": true,
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
                "sourceRefs": {
                  "type": "array",
                  "itemType": "string",
                  "required": true,
                  "minItems": 1,
                  "label": "规划输入 key（不是 sourceRef）"
                },
                "dependsOn": {
                  "type": "array",
                  "itemType": "string",
                  "label": "前置单元"
                }
              }
            },
            "coverage": {
              "title": "整体覆盖",
              "cardinality": "one",
              "format": "markdown",
              "required": true
            },
            "ordering": {
              "title": "顺序与依赖",
              "cardinality": "one",
              "format": "markdown"
            }
          }
        }
      },
      "phases": {
        "inputs": {
          "type": "builtin",
          "builtin": "delivery-plan-inputs"
        },
        "planning_basis": {
          "type": "artifact",
          "artifacts": [
            "delivery-plan.rationale"
          ],
          "instructions": "基于冻结规划输入和实时项目事实说明拆分依据。依据必须围绕参与者、触发条件、状态边界和可独立验收的业务结果，不要按文件、模块、技术层或工作量拆分。"
        },
        "delivery_units": {
          "type": "artifact",
          "artifacts": [
            "delivery-plan.units"
          ],
          "instructions": "一次登记当前已知的完整交付单元集合。每个单元必须形成参与者、触发条件、用户可观察结果和验收语义闭环，并通过 sourceRefs 承接真实规划输入。sourceRefs 逐字填写冻结 sources 的 key（如 impact:xxx 或 acceptance:xxx），不是 sourceRef、Context ref 或完整来源路径；dependsOn 只登记业务上必须先完成的稳定 unit key。"
        },
        "coverage_order": {
          "type": "artifact",
          "artifacts": [
            "delivery-plan.units",
            "delivery-plan.coverage",
            "delivery-plan.ordering"
          ],
          "instructions": "说明全部有效单元组合后如何覆盖本轮目标，并复核每项冻结输入都由真实承接它的单元引用。多个单元时必须说明推荐顺序与依赖依据；无法证明可以独立时合并为较大的业务闭环。"
        },
        "finalize": {
          "type": "builtin",
          "builtin": "delivery-plan-finalize"
        }
      }
    })
    ];
  },

};
