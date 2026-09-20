import {
  BankStatementEntryDirection,
  BankStatementMatchStatus,
} from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const PositiveAmountSchema = z
  .string()
  .trim()
  .regex(
    /^(?:0\.(?:0[1-9]|[1-9]\d?)|[1-9]\d{0,15}(?:\.\d{1,2})?)$/,
    'Amount must be greater than zero with at most 2 decimal places',
  );

const DateSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const OptionalDateSchema = DateSchema.optional();

const BankReferenceSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    'Bank reference contains unsupported characters',
  );

const BankStatementEntrySchema = z.object({
  externalId: z.string().trim().min(1).max(120),
  direction: z.enum(BankStatementEntryDirection),
  amount: PositiveAmountSchema,
  transactionDate: DateSchema,
  bankReference: BankReferenceSchema.optional(),
  description: z.string().trim().min(1).max(500).optional(),
});

export class CreateBankStatementImportDto extends createZodDto(
  z
    .object({
      fundId: z.uuid('Invalid fund ID'),
      sourceFileName: z.string().trim().min(1).max(255),
      statementFrom: DateSchema,
      statementTo: DateSchema,
      entries: z.array(BankStatementEntrySchema).min(1).max(100),
    })
    .superRefine((value, context) => {
      if (value.statementFrom >= value.statementTo) {
        context.addIssue({
          code: 'custom',
          path: ['statementTo'],
          message: 'Statement end must be after statement start',
        });
      }
      value.entries.forEach((entry, index) => {
        if (
          entry.transactionDate < value.statementFrom ||
          entry.transactionDate >= value.statementTo
        ) {
          context.addIssue({
            code: 'custom',
            path: ['entries', index, 'transactionDate'],
            message: 'Transaction date must be within the statement period',
          });
        }
      });
    }),
) {}

export class GetBankStatementImportsDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    fundId: z.uuid('Invalid fund ID').optional(),
    createdFrom: OptionalDateSchema,
    createdTo: OptionalDateSchema,
  }),
) {}

export class GetBankStatementEntriesDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    importId: z.uuid('Invalid statement import ID').optional(),
    fundId: z.uuid('Invalid fund ID').optional(),
    matchStatus: z.enum(BankStatementMatchStatus).optional(),
    direction: z.enum(BankStatementEntryDirection).optional(),
    transactionFrom: OptionalDateSchema,
    transactionTo: OptionalDateSchema,
  }),
) {}

export class IgnoreBankStatementEntryDto extends createZodDto(
  z.object({
    reason: z.string().trim().min(1).max(500),
  }),
) {}

export class RegisterBankDepositDto extends createZodDto(
  z.object({
    bankReference: BankReferenceSchema,
    evidenceReference: z.string().trim().min(1).max(500),
  }),
) {}
