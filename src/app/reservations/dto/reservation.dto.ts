import { ReservationRequestStatus, ReservationStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const ReservationDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const ReservationFields = {
  customerName: z.string().trim().min(1).max(120).nullish(),
  phoneNumber: z
    .string()
    .trim()
    .min(8)
    .max(20)
    .regex(/^[0-9+()\-\s]+$/, 'Invalid phone number'),
  tableId: z.uuid('Invalid UUID for dining table'),
  startsAt: ReservationDateTimeSchema,
  endsAt: ReservationDateTimeSchema,
  guestCount: z.number().int().min(1).max(50),
  notes: z.string().trim().max(500).nullish(),
};

const validateWindow = (
  value: { startsAt?: Date; endsAt?: Date },
  context: z.RefinementCtx,
) => {
  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    context.addIssue({
      code: 'custom',
      message: 'endsAt must be after startsAt',
      path: ['endsAt'],
    });
  }
};

export class CreateReservationDto extends createZodDto(
  z.object(ReservationFields).superRefine(validateWindow),
) {}

export class UpdateReservationDto extends createZodDto(
  z
    .object({
      customerName: ReservationFields.customerName,
      phoneNumber: ReservationFields.phoneNumber.optional(),
      tableId: ReservationFields.tableId.optional(),
      startsAt: ReservationFields.startsAt.optional(),
      endsAt: ReservationFields.endsAt.optional(),
      guestCount: ReservationFields.guestCount.optional(),
      notes: ReservationFields.notes,
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field must be provided',
    })
    .superRefine(validateWindow),
) {}

export class GetReservationsDto extends createZodDto(
  z
    .object({
      itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
      page: z.coerce.number().int().min(1).default(1),
      status: z.enum(ReservationStatus).optional(),
      tableId: z.uuid('Invalid UUID for dining table').optional(),
      phoneNumber: z.string().trim().min(1).max(20).optional(),
      startsFrom: ReservationDateTimeSchema.optional(),
      startsTo: ReservationDateTimeSchema.optional(),
    })
    .refine(
      ({ startsFrom, startsTo }) =>
        !startsFrom || !startsTo || startsFrom <= startsTo,
      {
        message: 'startsFrom must be before or equal to startsTo',
        path: ['startsFrom'],
      },
    ),
) {}

export class ReservationIdDto extends createZodDto(
  z.object({ id: z.coerce.number().int().positive() }),
) {}

export class CancelReservationDto extends createZodDto(
  z.object({ reason: z.string().trim().min(1).max(500) }),
) {}

export class CreatePublicReservationRequestDto extends createZodDto(
  z
    .object({
      customerName: z.string().trim().min(1).max(120),
      phoneNumber: ReservationFields.phoneNumber,
      startsAt: ReservationFields.startsAt,
      endsAt: ReservationFields.endsAt,
      guestCount: ReservationFields.guestCount,
      notes: ReservationFields.notes,
    })
    .superRefine(validateWindow),
) {}

export class TrackPublicReservationRequestDto extends createZodDto(
  z.object({ accessToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
) {}

export class GetReservationRequestsDto extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).default(1),
    status: z.enum(ReservationRequestStatus).optional(),
  }),
) {}

export class ReservationRequestIdDto extends createZodDto(
  z.object({ id: z.uuid() }),
) {}

export class ApproveReservationRequestDto extends createZodDto(
  z.object({ tableId: ReservationFields.tableId }),
) {}

export class RejectReservationRequestDto extends createZodDto(
  z.object({ reason: z.string().trim().min(1).max(500) }),
) {}
