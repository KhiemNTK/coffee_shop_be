import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { Pagination } from '../../../common/utils/pagination-util/pagination-util.interface';

const IsExistPermissionKeySchema = z.object({
  employeeId: z.uuid('Invalid UUID for employee'),
  permissionKey: z.string().min(1),
});

export class IsExistPermissionKeyDto extends createZodDto(
  IsExistPermissionKeySchema,
) {}

export class GetEmployeesPaginationDto extends createZodDto(
  Pagination.schema.extend({
    page: z.coerce.number().int().min(1).default(1),
    itemPerPage: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().min(1).max(120).optional(),
    isActive: z.preprocess((value) => {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }, z.boolean().optional()),
    positionId: z.uuid().optional(),
  }),
) {}
