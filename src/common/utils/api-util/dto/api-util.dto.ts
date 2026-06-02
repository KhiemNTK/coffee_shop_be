import { z } from 'zod';

interface FormatResponseParams {
  errors?: null | Record<string, any>[];
  data?: null | any;
  message?: string;
  [key: string]: any;
}

export type { FormatResponseParams };

export const FormatResponseSchema = z
  .object({
    errors: z.array(z.record(z.any())).nullable().optional(),
    data: z.any().nullable().optional(),
    message: z.string().optional(),
  })
  .catchall(z.any());
