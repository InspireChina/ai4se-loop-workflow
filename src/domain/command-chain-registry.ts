import type {
  ArtifactBlockReference,
  CommandChainPhaseDefinition,
} from './command-chain-types';

export type CommandId = string;
export type BuiltinId = string;

export type CommandDefinition = {
  id: CommandId;
  tokens: readonly [string, ...string[]];
  kind: 'read' | 'write' | 'lifecycle';
  usage: string;
  summary: string;
};

export type BuiltinCompileContext = {
  commandChainId: string;
  phaseId: string;
  phaseIds: string[];
  artifacts: ArtifactBlockReference[];
};

export type BuiltinDefinition = {
  id: BuiltinId;
  label: string;
  acceptsArtifacts: boolean;
  allowsReadonlyArtifacts?: boolean;
  compile(context: BuiltinCompileContext): Omit<CommandChainPhaseDefinition, 'inputs'>;
};

function commandKey(tokens: readonly string[]) {
  return tokens.join(' ');
}

export class CommandChainRegistry {
  readonly #commands = new Map<CommandId, CommandDefinition>();
  readonly #commandIdsByKey = new Map<string, CommandId>();
  readonly #builtins = new Map<BuiltinId, BuiltinDefinition>();

  registerCommand(definition: CommandDefinition) {
    if (this.#commands.has(definition.id)) {
      throw new Error(`重复注册命令：${definition.id}`);
    }
    const key = commandKey(definition.tokens);
    if (this.#commandIdsByKey.has(key)) {
      throw new Error(`重复注册命令语法：${key}`);
    }
    this.#commands.set(definition.id, definition);
    this.#commandIdsByKey.set(key, definition.id);
    return this;
  }

  registerBuiltin(definition: BuiltinDefinition) {
    if (this.#builtins.has(definition.id)) {
      throw new Error(`重复注册内置 Phase：${definition.id}`);
    }
    this.#builtins.set(definition.id, definition);
    return this;
  }

  command(id: CommandId) {
    const definition = this.#commands.get(id);
    if (!definition) throw new Error(`未知注册命令：${id}`);
    return definition;
  }

  resolveCommand(positionals: string[]) {
    let resolved: CommandDefinition | null = null;
    for (const definition of this.#commands.values()) {
      if (definition.tokens.length > positionals.length) continue;
      if (!definition.tokens.every((token, index) => positionals[index] === token)) continue;
      if (!resolved || definition.tokens.length > resolved.tokens.length) resolved = definition;
    }
    return resolved;
  }

  builtin(id: BuiltinId) {
    return this.#builtins.get(id) || null;
  }

  compileBuiltin(id: BuiltinId, context: Omit<BuiltinCompileContext, 'phaseId'> & { phaseId: string }) {
    const definition = this.builtin(id);
    if (!definition) throw new Error(`未知内置 Phase：${id}`);
    if (!definition.acceptsArtifacts && context.artifacts.length) {
      throw new Error(`内置 Phase ${id} 不接受 Artifact Block`);
    }
    if (!definition.allowsReadonlyArtifacts && context.artifacts.some(({ block }) => !block.writable)) {
      throw new Error(`内置 Phase ${id} 不能写入只读 Artifact Block`);
    }
    const phase = definition.compile(context);
    if (phase.type !== 'builtin' || phase.builtin !== id) {
      throw new Error(`内置 Phase ${id} 编译结果身份不一致`);
    }
    if (phase.title !== definition.label) {
      throw new Error(`内置 Phase ${id} 编译结果标题必须为 ${definition.label}`);
    }
    for (const usage of phase.commands) {
      if (!this.resolveCommand(usage.trim().split(/\s+/))) {
        throw new Error(`内置 Phase ${id} 引用了未注册命令：${usage}`);
      }
    }
    return phase;
  }

  commands() {
    return [...this.#commands.values()];
  }

  builtins() {
    return [...this.#builtins.values()];
  }
}

export const commandChainRegistry = new CommandChainRegistry();

const COMMAND_DEFINITIONS: CommandDefinition[] = [
  { id: 'status', tokens: ['status'], kind: 'read', usage: 'status', summary: '恢复当前草稿和阶段工作包' },
  { id: 'delivery-unit.current', tokens: ['delivery-unit', 'current'], kind: 'read', usage: 'delivery-unit current', summary: '读取当前交付单元' },
  { id: 'delivery-spec.current', tokens: ['delivery-spec', 'current'], kind: 'read', usage: 'delivery-spec current', summary: '读取当前 Delivery Spec' },
  { id: 'acceptance.put', tokens: ['acceptance', 'put'], kind: 'write', usage: 'acceptance put --key <key> --content-file <yaml>', summary: '登记 Acceptance' },
  { id: 'acceptance.remove', tokens: ['acceptance', 'remove'], kind: 'write', usage: 'acceptance remove --key <key>', summary: '删除 Acceptance' },
  { id: 'acceptance.assess', tokens: ['acceptance', 'assess'], kind: 'write', usage: 'acceptance assess --key <key> --result <result> --evidence-file <text>', summary: '登记 Acceptance 评估' },
  { id: 'artifact.put', tokens: ['artifact', 'put'], kind: 'write', usage: 'artifact put --artifact <id> --block <id> [--key <key>] --content-file <yaml|markdown>', summary: '写入 Artifact Block' },
  { id: 'artifact.remove', tokens: ['artifact', 'remove'], kind: 'write', usage: 'artifact remove --artifact <id> --block <id> [--key <key>]', summary: '删除 Artifact Block' },
  { id: 'artifact.template', tokens: ['artifact', 'template'], kind: 'read', usage: 'artifact template --artifact <id> --block <id>', summary: '读取 Artifact Block 模板' },
  { id: 'schema.show', tokens: ['schema', 'show'], kind: 'read', usage: 'schema show --artifact <id> --block <id>', summary: '读取 Artifact Block Schema' },
  { id: 'decision.put', tokens: ['decision', 'put'], kind: 'write', usage: 'decision put --tree <id> --key <key> --content-file <yaml>', summary: '登记 Decision' },
  { id: 'decision.remove', tokens: ['decision', 'remove'], kind: 'write', usage: 'decision remove --tree <id> --key <key>', summary: '删除 Decision' },
  { id: 'decision.resolve', tokens: ['decision', 'resolve'], kind: 'write', usage: 'decision resolve --tree <id> --key <key> --option <id> --authority <authority> --decision-file <text> --rationale-file <text> --evidence-file <text>', summary: '关闭 Decision' },
  { id: 'decision.ask', tokens: ['decision', 'ask'], kind: 'write', usage: 'decision ask --tree <id> --key <key>', summary: '请求用户回答 Decision' },
  { id: 'decision.reopen', tokens: ['decision', 'reopen'], kind: 'write', usage: 'decision reopen --tree <id> --key <key>', summary: '重新打开 Decision' },
  { id: 'decision.template', tokens: ['decision', 'template'], kind: 'read', usage: 'decision template --tree <id>', summary: '读取 Decision 模板' },
  { id: 'schema.decision', tokens: ['schema', 'decision'], kind: 'read', usage: 'schema decision --tree <id>', summary: '读取 Decision Schema' },
  { id: 'check.record', tokens: ['check', 'record'], kind: 'write', usage: 'check record --key <key> --receipt <receipt> --summary <summary>', summary: '登记命令检查事实' },
  { id: 'check.remove', tokens: ['check', 'remove'], kind: 'write', usage: 'check remove --key <key>', summary: '删除命令检查事实' },
  { id: 'runtime-input.put', tokens: ['runtime-input', 'put'], kind: 'write', usage: 'runtime-input put --key <key> --title <title> --question <question> --why <why> --recommendation <recommendation>', summary: '登记运行时输入请求' },
  { id: 'runtime-input.remove', tokens: ['runtime-input', 'remove'], kind: 'write', usage: 'runtime-input remove --key <key>', summary: '删除运行时输入请求' },
  { id: 'metadata.set', tokens: ['metadata', 'set'], kind: 'write', usage: 'metadata set --key <key> --value <value>', summary: '写入需求 Metadata' },
  { id: 'metadata.remove', tokens: ['metadata', 'remove'], kind: 'write', usage: 'metadata remove --key <key>', summary: '删除需求 Metadata' },
  { id: 'phase.complete', tokens: ['phase', 'complete'], kind: 'lifecycle', usage: 'phase complete', summary: '校验并完成当前阶段' },
  { id: 'phase.rewind', tokens: ['phase', 'rewind'], kind: 'lifecycle', usage: 'phase rewind --to <earlier-phase> --reason <reason>', summary: '回退到更早阶段' },
];

for (const definition of COMMAND_DEFINITIONS) commandChainRegistry.registerCommand(definition);

export const BUILTIN_PHASE_IDS = [
  'acceptance-definition',
  'delivery-unit',
  'delivery-plan-inputs',
  'verification-inputs',
  'verification-plan',
  'verification-execution',
  'delivery-spec',
  'implementation-evidence',
  'command-verification',
  'decision-proposal',
  'decision-resolution',
  'decision-answer-review',
  'requirement-context-finalize',
  'delivery-plan-finalize',
  'reproduction-finalize',
  'verification-finalize',
  'review-inputs',
  'review-reconciliation',
  'review-output',
  'review-finalize',
  'feedback-triage-inputs',
  'feedback-triage-finalize',
  'feedback-verify-inputs',
  'feedback-verify-finalize',
  'business-analysis-finalize',
] as const;
