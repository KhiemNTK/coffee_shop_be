import { z } from 'zod';
export type { FormatResponseParams } from '../../../types';

export const FormatResponseSchema = z
  .object({
    errors: z.array(z.record(z.string(), z.any())).nullable().optional(),
    data: z.any().nullable().optional(),
    message: z.string().optional(),
  })
  .catchall(z.any());
