import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class ExpectedCustomerDto extends createZodDto(
  z.object({ expectedCustomerId: z.uuid() }),
) {}
