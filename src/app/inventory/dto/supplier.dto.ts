import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { InventoryPaginationSchema } from './inventory-common.dto';

const SupplierFieldsSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Invalid supplier code'),
  name: z.string().trim().min(1).max(160),
  contactName: z.string().trim().min(1).max(120).nullish(),
  phoneNumber: z.string().trim().min(6).max(32).nullish(),
  email: z.email().max(254).nullish(),
  address: z.string().trim().min(1).max(300).nullish(),
  taxCode: z.string().trim().min(1).max(64).nullish(),
  notes: z.string().trim().min(1).max(500).nullish(),
});

export class CreateSupplierDto extends createZodDto(SupplierFieldsSchema) {}

export class UpdateSupplierDto extends createZodDto(
  SupplierFieldsSchema.partial().refine(
    (value) => Object.keys(value).length > 0,
    'At least one field is required',
  ),
) {}

export class GetSuppliersDto extends createZodDto(
  InventoryPaginationSchema.pick({
    itemPerPage: true,
    page: true,
    keyword: true,
  }),
) {}
