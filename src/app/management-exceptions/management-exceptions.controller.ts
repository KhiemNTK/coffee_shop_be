import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { GetManagementExceptionsDto } from './dto/get-management-exceptions.dto';
import { RetryOutboxEventDto } from './dto/retry-outbox-event.dto';
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

  @Post('outbox/:id/retry')
  @RequirePermissions(
    PermissionKeys.MANAGEMENT_EXCEPTIONS_READ,
    PermissionKeys.OUTBOX_EVENTS_RETRY,
  )
  retryOutboxEvent(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: RetryOutboxEventDto,
  ) {
    return this.exceptions.retryOutboxEvent(id, employeeId, dto);
  }
}
