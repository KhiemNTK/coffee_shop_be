import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export class GetOptionsParams extends createZodDto(
  z
    .object({
      limit: z.coerce.number().int().positive().optional(),
      select: z.string().optional(),
    })
    .loose(),
) {}

export type { Options } from '../types';
