import { z } from 'zod';

export const acceptanceReferenceSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1).max(120),
  scope: z.enum(['requirement', 'delivery_unit']),
  statement: z.string().min(1).max(4000),
  oracle: z.string().min(1).max(4000),
  sourceRef: z.string().min(1).max(500),
  revision: z.number().int().positive(),
});

export type AcceptanceReference = z.infer<typeof acceptanceReferenceSchema>;
