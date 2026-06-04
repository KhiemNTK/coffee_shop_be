import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateEmployeeInputSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, 'Full name is required')
    .max(100, 'Full name is too long'),

  email: z.email('Invalid email address').max(255),

  phoneNumber: z
    .string()
    .trim()
    .min(10, 'Phone number must be at least 10 characters')
    .max(15, 'Phone number is too long')
    .optional()
    .nullable(),
  address: z.string().trim().max(500).optional().nullable(),

  avatarUrl: z.url('Avatar must be a valid URL').optional().nullable(),

  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(50),

  password: z
    .string()
    .trim()
    .min(6, 'Password must be at least 6 characters')
    .max(100),

  isActive: z.boolean().optional().default(true),

  positionId: z.uuid('Invalid UUID for position'),
});

export class CreateEmployeeDto extends createZodDto(
  CreateEmployeeInputSchema,
) {}
