import type { databaseConnection } from '../infrastructure/database';

export type CommandDatabase = Awaited<ReturnType<typeof databaseConnection>>;

export type CommandChainDraftRow = {
  draft_id: string;
  draft_version: number;
  task_id: string;
  story_index: number | null;
  status: 'editing' | 'waiting_for_answers' | 'submitted' | 'abandoned';
  change_seq: number;
  last_execution_id: string | null;
  status_viewed_execution_id: string | null;
  terminal_execution_id: string | null;
  terminal_action: string | null;
  command_chain_id: string | null;
};

export type CommandChainExecutionRow = {
  execution_id: string;
  task_id: string;
  story_index: number | null;
  pipeline: string;
  input_json: string;
};

export type RequirementContextProjection = {
  draftId: string;
  intent: string;
  assertions: {
    key: string;
    perspective: 'actual' | 'expected' | 'target';
    statement: string;
    evidence: 'observed' | 'reported' | 'inferred' | 'decided' | 'conflicted';
    source: string;
    decision?: string;
  }[];
  changeSummary: string;
  impacts: {
    key: string;
    statement: string;
    disposition: 'change' | 'preserve' | 'needs_decision' | 'technical';
    rationale: string;
    source: string;
    decision?: string;
  }[];
  scope: { key: string; direction: 'included' | 'excluded'; content: string }[];
  constraints: { key: string; content: string }[];
  acceptance: { key: string; content: string; oracle: string; source: string }[];
};
