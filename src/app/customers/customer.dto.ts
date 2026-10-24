import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CreateOnlineOrderDto,
  GetPendingOnlineOrdersDto,
  RecoverOnlineOrderByKeyDto,
} from '../online-orders/dto';

export class ExpectedCustomerDto extends createZodDto(
  z.object({ expectedCustomerId: z.uuid() }),
) {}

export class CreateCustomerOrderDto extends createZodDto(
  CreateOnlineOrderDto.schema
    .safeExtend({ expectedCustomerId: z.uuid() })
    .strict(),
) {}

export class RecoverCustomerOrderByKeyDto extends createZodDto(
  RecoverOnlineOrderByKeyDto.schema
    .extend({ expectedCustomerId: z.uuid() })
    .strict(),
) {}

export class GetCustomerOrdersDto extends createZodDto(
  GetPendingOnlineOrdersDto.schema
    .pick({ page: true, itemPerPage: true })
    .extend({ page: z.coerce.number().int().min(1).max(1000).default(1) })
    .strict(),
) {}
