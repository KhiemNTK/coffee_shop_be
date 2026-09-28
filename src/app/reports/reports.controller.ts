import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { ExportExcel } from '../../common/utils/excel-util/excel-util.decorator';
import { Employee } from '../../common/decorators/employee.decorator';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  BusinessDateDto,
  GetDashboardReportDto,
  GetOnlineOrderJourneyDto,
  GetKitchenSlaDto,
} from './dto';
import { DailySalesCloseService } from './daily-sales-close.service';
import { ReportsService } from './reports.service';

@ApiTags('Reports')
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly dailySalesCloseService: DailySalesCloseService,
  ) {}

  @Post('daily-closes')
  @RequirePermissions(PermissionKeys.REPORTS_CLOSE)
  closeDay(
    @Employee('employeeId') employeeId: string,
    @Body() dto: BusinessDateDto,
  ) {
    return this.dailySalesCloseService.close(dto.businessDate, employeeId);
  }

  @Get('daily-closes/:businessDate')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getDailyClose(@Param() params: BusinessDateDto) {
    return this.dailySalesCloseService.get(params.businessDate);
  }

  @Get('dashboard')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getDashboard(@Query() query: GetDashboardReportDto) {
    return this.reportsService.getDashboard(query);
  }

  @Get('online-orders')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getOnlineOrderJourney(@Query() query: GetOnlineOrderJourneyDto) {
    return this.reportsService.getOnlineOrderJourney(query);
  }

  @Get('kitchen-sla')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getKitchenSla(@Query() query: GetKitchenSlaDto) {
    return this.reportsService.getKitchenSla(query);
  }

  @Get('kitchen-bottlenecks')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  @Header('Cache-Control', 'no-store')
  getKitchenBottlenecks(@Query() query: GetKitchenSlaDto) {
    return this.reportsService.getKitchenBottlenecks(query);
  }

  @Get('dashboard/export')
  @RequirePermissions(PermissionKeys.REPORTS_EXPORT)
  @ExportExcel()
  exportDashboard(@Query() query: GetDashboardReportDto) {
    return this.reportsService.exportDashboard(query);
  }
}
