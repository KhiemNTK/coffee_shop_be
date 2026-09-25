import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const StationInputSchema = {
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
  prepSlaSeconds: z.number().int().min(30).max(86_400),
  printDeviceId: z.uuid().nullable().optional(),
};

export class CreateKitchenStationDto extends createZodDto(
  z.object(StationInputSchema),
) {}

export class UpdateKitchenStationDto extends createZodDto(
  z
    .object({
      code: StationInputSchema.code.optional(),
      name: StationInputSchema.name.optional(),
      prepSlaSeconds: StationInputSchema.prepSlaSeconds.optional(),
      printDeviceId: StationInputSchema.printDeviceId,
      isActive: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field must be provided',
    }),
) {}

export class GetKitchenStationsDto extends createZodDto(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    isActive: z.preprocess((value) => {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }, z.boolean().optional()),
  }),
) {}

export class GetKitchenTicketsDto extends createZodDto(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    itemPerPage: z.coerce.number().int().min(1).max(100).default(50),
    stationId: z.uuid().optional(),
    includeCompleted: z.preprocess((value) => {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }, z.boolean().default(false)),
  }),
) {}
