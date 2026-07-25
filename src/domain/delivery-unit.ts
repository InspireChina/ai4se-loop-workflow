import { z } from 'zod';

export const deliveryPlanSourceKindSchema = z.enum([
  'change',
  'preserve',
  'technical',
  'acceptance',
]);

export const deliveryPlanSourceRefSchema = z.object({
  key: z.string().min(1).max(240),
  kind: deliveryPlanSourceKindSchema,
  content: z.string().min(1).max(4000),
  sourceRef: z.string().min(1).max(500),
});

export const deliveryUnitContractSchema = z.object({
  key: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  actor: z.string().min(1).max(500),
  trigger: z.string().min(1).max(4000),
  observableOutcome: z.string().min(1).max(4000),
  acceptance: z.string().min(1).max(4000),
  sourceRefs: z.array(deliveryPlanSourceRefSchema).min(1).max(200),
  dependsOn: z.array(z.string().min(1).max(120)).max(50).default([]),
});

export type DeliveryPlanSourceKind = z.infer<typeof deliveryPlanSourceKindSchema>;
export type DeliveryPlanSourceRef = z.infer<typeof deliveryPlanSourceRefSchema>;
export type DeliveryUnitContract = z.infer<typeof deliveryUnitContractSchema>;
