import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { AuditLogsService } from './audit-logs.service';
import { GetAuditLogsDto } from './dto/get-audit-logs.dto';

@ApiTags('audit-logs')
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @RequirePermissions(PermissionKeys.AUDIT_LOGS_READ)
  findAll(@Query() query: GetAuditLogsDto) {
    return this.auditLogs.findAll(query);
  }
}
