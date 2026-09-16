import { z } from 'zod';
import { AGENT_EXECUTORS } from './agent-executor';

/** Persist invocation choices, never provider credentials or inherited
 * execution authority. CLI credentials remain in the runtime environment. */
export const adminRuntimeConfigurationSchema = z.object({
  configurationId: z.string().trim().min(1).max(500),
  sourceVersion: z.string().trim().min(1).max(500),
  executorId: z.enum(AGENT_EXECUTORS),
  executionOptions: z.object({
    model: z.string().trim().min(1).max(500).optional(),
    reasoningEffort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']).optional(),
    webSearch: z.boolean().optional(),
  }).strict(),
}).strict();
export type AdminRuntimeConfiguration = z.infer<typeof adminRuntimeConfigurationSchema>;
export type AdminRuntimeSnapshot = { revision: number; configuration: AdminRuntimeConfiguration; updatedAt: number };
