import {
  PrintDeviceStatus,
  PrintDeviceType,
  PrintJobStatus,
  PrintJobType,
} from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
});

const DeviceInputSchema = {
  name: z.string().trim().min(1).max(120),
  type: z.enum(PrintDeviceType),
  paperSize: z.string().trim().min(1).max(40),
  isDefault: z.boolean().optional(),
};

export class CreatePrintDeviceDto extends createZodDto(
  z.object(DeviceInputSchema),
) {}

export class UpdatePrintDeviceDto extends createZodDto(
  z
    .object({
      name: DeviceInputSchema.name.optional(),
      type: DeviceInputSchema.type.optional(),
      paperSize: DeviceInputSchema.paperSize.optional(),
      isDefault: z.boolean().optional(),
      isActive: z.boolean().optional(),
      status: z.enum(PrintDeviceStatus).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field must be provided',
    }),
) {}

export class GetPrintDevicesDto extends createZodDto(
  PaginationSchema.extend({
    type: z.enum(PrintDeviceType).optional(),
    isActive: z.preprocess((value) => {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }, z.boolean().optional()),
  }),
) {}

export class GetPrintJobsDto extends createZodDto(
  PaginationSchema.extend({
    type: z.enum(PrintJobType).optional(),
    status: z.enum(PrintJobStatus).optional(),
    deviceId: z.uuid().optional(),
    invoiceId: z.uuid().optional(),
  }),
) {}

export class RetryPrintJobDto extends createZodDto(
  z.object({
    deviceId: z.uuid().nullable().optional(),
  }),
) {}

export class ReprintReceiptDto extends createZodDto(
  z.object({
    reason: z.string().trim().min(3).max(500),
    copies: z.number().int().min(1).max(5).default(1),
    deviceId: z.uuid().optional(),
    idempotencyKey: z.string().trim().min(8).max(120),
  }),
) {}

export class PrintAgentHeartbeatDto extends createZodDto(
  z.object({
    status: z.enum([PrintDeviceStatus.READY, PrintDeviceStatus.ERROR]),
    error: z.string().trim().min(1).max(2_000).nullable().optional(),
  }),
) {}

export class ClaimPrintJobsDto extends createZodDto(
  z.object({
    limit: z.number().int().min(1).max(50).default(10),
  }),
) {}

const LeaseTokenSchema = z.string().trim().min(32).max(128);

export class CompletePrintJobDto extends createZodDto(
  z.object({ leaseToken: LeaseTokenSchema }),
) {}

export class FailPrintJobDto extends createZodDto(
  z.object({
    leaseToken: LeaseTokenSchema,
    error: z.string().trim().min(1).max(2_000),
  }),
) {}
