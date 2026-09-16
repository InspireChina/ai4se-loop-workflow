import {z} from 'zod';

export const uiLifecycleActionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('start')}).strict(),
  z.object({kind:z.literal('stop'),reason:z.literal('user-stop').optional()}).strict(),
  z.object({kind:z.literal('resume-after-update')}).strict(),
]);
export const uiLifecycleRequestSchema=z.discriminatedUnion('operation',[
  z.object({kind:z.literal('ui-lifecycle-request'),allocationId:z.string().uuid(),requestId:z.string().uuid(),operation:z.literal('status')}).strict(),
  z.object({kind:z.literal('ui-lifecycle-request'),allocationId:z.string().uuid(),requestId:z.string().uuid(),operation:z.literal('command'),
    command:z.object({requestId:z.string().uuid(),action:uiLifecycleActionSchema}).strict()}).strict(),
]);
export type UiLifecycleRequest=z.infer<typeof uiLifecycleRequestSchema>;
