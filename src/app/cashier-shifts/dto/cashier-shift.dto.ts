import {
  CashExpenseRequestStatus,
  CashFlowType,
  CashHandoverStatus,
  FundType,
  ShiftStatus,
} from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const CashAmountSchema = z
  .string()
  .trim()
  .regex(
    /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/,
    'Amount must be a non-negative decimal with at most 2 decimal places',
  );

const PositiveCashAmountSchema = z
  .string()
  .trim()
  .regex(
    /^(?:0\.(?:0[1-9]|[1-9]\d?)|[1-9]\d{0,15}(?:\.\d{1,2})?)$/,
    'Amount must be greater than zero with at most 2 decimal places',
  );

const OptionalDateSchema = z
  .string()
  .datetime({ offset: true })
  .optional()
  .transform((value) => (value ? new Date(value) : undefined));

export class CreateFundDto extends createZodDto(
  z.object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(FundType),
    openingBalance: CashAmountSchema.optional().default('0'),
  }),
) {}

export class UpdateFundDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      type: z.enum(FundType).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field must be provided',
    }),
) {}

export class GetFundsDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    keyword: z.string().trim().min(1).max(120).optional(),
    type: z.enum(FundType).optional(),
  }),
) {}

export class OpenCashierShiftDto extends createZodDto(
  z.object({
    fundId: z.uuid('Invalid fund ID'),
    startingCash: CashAmountSchema,
  }),
) {}

export class CloseCashierShiftDto extends createZodDto(
  z.object({
    reportedEndingCash: CashAmountSchema,
    closingNote: z.string().trim().min(1).max(500).nullish(),
  }),
) {}

export class CreateCashMovementDto extends createZodDto(
  z.object({
    type: z.enum(CashFlowType),
    amount: PositiveCashAmountSchema,
    description: z.string().trim().min(1).max(300),
  }),
) {}

export class GetCashierShiftsDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    status: z.enum(ShiftStatus).optional(),
    employeeId: z.uuid('Invalid employee ID').optional(),
    fundId: z.uuid('Invalid fund ID').optional(),
    openedFrom: OptionalDateSchema,
    openedTo: OptionalDateSchema,
  }),
) {}

export class GetCashExpenseRequestsDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    status: z.enum(CashExpenseRequestStatus).optional(),
    requestedById: z.uuid('Invalid employee ID').optional(),
    shiftId: z.uuid('Invalid cashier shift ID').optional(),
  }),
) {}

export class ApproveCashExpenseRequestDto extends createZodDto(
  z.object({
    note: z.string().trim().min(1).max(500).nullish(),
  }),
) {}

export class RejectCashExpenseRequestDto extends createZodDto(
  z.object({
    reason: z.string().trim().min(1).max(500),
  }),
) {}

export class CreateCashHandoverDto extends createZodDto(
  z.object({
    shiftId: z.uuid('Invalid cashier shift ID'),
    destinationFundId: z.uuid('Invalid destination fund ID'),
    retainedCash: CashAmountSchema,
    note: z.string().trim().min(1).max(500).nullish(),
  }),
) {}

export class GetCashHandoversDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    status: z.enum(CashHandoverStatus).optional(),
    shiftId: z.uuid('Invalid cashier shift ID').optional(),
    requestedById: z.uuid('Invalid employee ID').optional(),
    sourceFundId: z.uuid('Invalid source fund ID').optional(),
    destinationFundId: z.uuid('Invalid destination fund ID').optional(),
    createdFrom: OptionalDateSchema,
    createdTo: OptionalDateSchema,
  }),
) {}

export class ApproveCashHandoverDto extends createZodDto(
  z.object({
    note: z.string().trim().min(1).max(500).nullish(),
  }),
) {}

export class RejectCashHandoverDto extends createZodDto(
  z.object({
    reason: z.string().trim().min(1).max(500),
  }),
) {}
