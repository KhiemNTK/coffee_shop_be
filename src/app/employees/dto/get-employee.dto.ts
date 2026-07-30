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

export class GetEmployeesPaginationDto extends Pagination {}
