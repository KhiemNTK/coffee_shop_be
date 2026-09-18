import { SettingValueType } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const SettingKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(100)
  .regex(
    /^[a-z][a-z0-9_.-]*$/,
    'Setting key must start with a letter and contain only lowercase letters, numbers, dots, underscores or hyphens',
  );

const assertTypedValue = (
  valueType: SettingValueType,
  value: unknown,
  context: z.RefinementCtx,
) => {
  const isValid =
    (valueType === SettingValueType.STRING && typeof value === 'string') ||
    (valueType === SettingValueType.NUMBER &&
      typeof value === 'number' &&
      Number.isFinite(value)) ||
    (valueType === SettingValueType.BOOLEAN && typeof value === 'boolean') ||
    (valueType === SettingValueType.JSON &&
      (value === null || typeof value === 'object'));

  if (!isValid) {
    context.addIssue({
      code: 'custom',
      message: `value does not match ${valueType}`,
      path: ['value'],
    });
  }
};

export class CreateSystemSettingDto extends createZodDto(
  z
    .object({
      key: SettingKeySchema,
      value: z.json(),
      valueType: z.enum(SettingValueType),
      description: z.string().trim().min(1).max(500).nullish(),
      isPublic: z.boolean().optional().default(false),
    })
    .superRefine(({ valueType, value }, context) =>
      assertTypedValue(valueType, value, context),
    ),
) {}

export class UpdateSystemSettingDto extends createZodDto(
  z
    .object({
      expectedVersion: z.number().int().positive(),
      value: z.json().optional(),
      description: z.string().trim().min(1).max(500).nullish(),
      isPublic: z.boolean().optional(),
    })
    .refine(
      ({ value, description, isPublic }) =>
        value !== undefined ||
        description !== undefined ||
        isPublic !== undefined,
      { message: 'At least one setting field must be provided' },
    ),
) {}

export class GetSystemSettingsDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    keyword: z.string().trim().min(1).max(120).optional(),
    valueType: z.enum(SettingValueType).optional(),
  }),
) {}

export class SystemSettingKeyDto extends createZodDto(
  z.object({ key: SettingKeySchema }),
) {}

export class DeleteSystemSettingDto extends createZodDto(
  z.object({ expectedVersion: z.coerce.number().int().positive() }),
) {}

export class GetSystemSettingRevisionsDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
  }),
) {}
