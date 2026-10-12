import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class ClearDiningTableDto extends createZodDto(
  z.object({ expectedOrderSessionId: z.uuid().nullable() }),
) {}
