import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { ExportExcel } from '../../common/utils/excel-util/excel-util.decorator';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { GetDashboardReportDto } from './dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('dashboard')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getDashboard(@Query() query: GetDashboardReportDto) {
    return this.reportsService.getDashboard(query);
  }

  @Get('dashboard/export')
  @RequirePermissions(PermissionKeys.REPORTS_EXPORT)
  @ExportExcel()
  exportDashboard(@Query() query: GetDashboardReportDto) {
    return this.reportsService.exportDashboard(query);
  }
}
