import { EquipmentStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const EquipmentDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const EquipmentMoneySchema = z
  .string()
  .trim()
  .regex(
    /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/,
    'Amount must be a non-negative decimal with at most 2 decimal places',
  );

const EquipmentFields = {
  assetCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(3)
    .max(50)
    .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Invalid asset code'),
  serialNumber: z.string().trim().min(1).max(100).nullish(),
  name: z.string().trim().min(1).max(160),
  quantity: z.number().int().min(1).max(10_000),
  unitPrice: EquipmentMoneySchema,
  purchaseDate: EquipmentDateTimeSchema,
  warrantyExpiresAt: EquipmentDateTimeSchema.nullish(),
  nextMaintenanceAt: EquipmentDateTimeSchema.nullish(),
  location: z.string().trim().min(1).max(120).nullish(),
  notes: z.string().trim().min(1).max(1000).nullish(),
};

export class CreateEquipmentDto extends createZodDto(
  z.object(EquipmentFields),
) {}

export class UpdateEquipmentDto extends createZodDto(
  z
    .object({
      serialNumber: EquipmentFields.serialNumber,
      name: EquipmentFields.name.optional(),
      quantity: EquipmentFields.quantity.optional(),
      unitPrice: EquipmentFields.unitPrice.optional(),
      purchaseDate: EquipmentFields.purchaseDate.optional(),
      warrantyExpiresAt: EquipmentFields.warrantyExpiresAt,
      nextMaintenanceAt: EquipmentFields.nextMaintenanceAt,
      location: EquipmentFields.location,
      notes: EquipmentFields.notes,
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field must be provided',
    }),
) {}

export class GetEquipmentDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    keyword: z.string().trim().min(1).max(120).optional(),
    status: z.enum(EquipmentStatus).optional(),
    maintenanceDueBefore: EquipmentDateTimeSchema.optional(),
  }),
) {}

export class TransitionEquipmentDto extends createZodDto(
  z.object({
    status: z.enum(EquipmentStatus),
    reason: z.string().trim().min(1).max(500),
    cost: EquipmentMoneySchema.optional().default('0'),
    occurredAt: EquipmentDateTimeSchema.optional(),
    nextMaintenanceAt: EquipmentDateTimeSchema.nullish(),
  }),
) {}

export class GetEquipmentEventsDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
  }),
) {}
