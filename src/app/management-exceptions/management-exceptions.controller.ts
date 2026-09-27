import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { GetManagementExceptionsDto } from './dto/get-management-exceptions.dto';
import { ManagementExceptionsService } from './management-exceptions.service';

@ApiTags('Management Exceptions')
@Controller('management/exceptions')
export class ManagementExceptionsController {
  constructor(private readonly exceptions: ManagementExceptionsService) {}

  @Get('summary')
  @RequirePermissions(PermissionKeys.MANAGEMENT_EXCEPTIONS_READ)
  summary() {
    return this.exceptions.summary();
  }

  @Get()
  @RequirePermissions(PermissionKeys.MANAGEMENT_EXCEPTIONS_READ)
  findAll(@Query() query: GetManagementExceptionsDto) {
    return this.exceptions.findAll(query);
  }
}
