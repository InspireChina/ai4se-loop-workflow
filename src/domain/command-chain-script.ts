import type { CommandChainDefinition } from './command-chain-definition';
import type { CommandDatabase, CommandChainDraftRow, CommandChainExecutionRow, RequirementContextProjection } from './command-chain-state';

export type CommandInvocation = {
  db: CommandDatabase;
  execution: CommandChainExecutionRow;
  draft: CommandChainDraftRow;
  command: string;
  positionals: string[];
  flags: Map<string, string>;
};

export type DirectInvocation = {
  db: CommandDatabase;
  execution: { execution_id: string; task_id: string; agent: string; pipeline: string; status: string };
  command: string;
  flags: Map<string, string>;
};

export type CommandRuntime = {
  initializeCommandChainDraft(db: CommandDatabase, execution: CommandChainExecutionRow, draft: CommandChainDraftRow): void;
  runCommandChainCommand(input: CommandInvocation): string;
  cloneCommandChainDraft(db: CommandDatabase, source: CommandChainDraftRow, target: CommandChainDraftRow): void;
  latestRequirementContextProjection(db: CommandDatabase, taskId: string): RequirementContextProjection | null;
  commandChainHelp(): string;
};

export type DirectRuntime = { directHelp(): string; runDirectCommand(input: DirectInvocation): string };

export type ScriptValidationContext = {
  db: CommandDatabase; draft: CommandChainDraftRow; names: string[];
  artifacts: unknown[]; decisions: unknown[]; tools: Record<string, unknown>;
};
export type ScriptResultContext = {
  db: CommandDatabase; draft: CommandChainDraftRow; needsInput: boolean; tools: Record<string, unknown>;
};

// Versioned host boundary. Implementations are trusted workspace code and run
// only after execution authorization in agent-command-drafts, just like before.
export type AgentCommandScript = {
  apiVersion: 1;
  agent: string;
  describe(host: { define(id: string, input: unknown): CommandChainDefinition }): CommandChainDefinition[];
  validate?(context: ScriptValidationContext): string[];
  result?(context: ScriptResultContext): unknown;
  initialize?(runtime: CommandRuntime, db: CommandDatabase, execution: CommandChainExecutionRow, draft: CommandChainDraftRow): void;
  execute?(runtime: CommandRuntime, invocation: CommandInvocation): string;
  restore?(runtime: CommandRuntime, db: CommandDatabase, source: CommandChainDraftRow, target: CommandChainDraftRow): void;
  project?(runtime: CommandRuntime, db: CommandDatabase, taskId: string): RequirementContextProjection | null;
  executeDirect?(runtime: DirectRuntime, invocation: DirectInvocation): string;
  help(runtime: CommandRuntime | DirectRuntime): string;
};
