import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CreateOnlineOrderDto,
  GetPendingOnlineOrdersDto,
  RecoverOnlineOrderByKeyDto,
  QuoteOnlineOrderDto,
} from '../online-orders/dto';

export class ExpectedCustomerDto extends createZodDto(
  z.object({ expectedCustomerId: z.uuid() }),
) {}

export class CreateCustomerOrderDto extends createZodDto(
  CreateOnlineOrderDto.schema
    .safeExtend({
      expectedCustomerId: z.uuid(),
      voucherId: z.uuid().optional(),
      expectedTotal: z
        .string()
        .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/)
        .optional(),
      quoteFingerprint: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.voucherId &&
        (!value.expectedTotal || !value.quoteFingerprint)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['voucherId'],
          message: 'A voucher requires a confirmed quote.',
        });
      }
    }),
) {}

export class QuoteCustomerOrderDto extends createZodDto(
  QuoteOnlineOrderDto.schema
    .safeExtend({
      expectedCustomerId: z.uuid(),
      voucherId: z.uuid().optional(),
    })
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
