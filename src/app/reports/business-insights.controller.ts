import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { BusinessInsightsService } from './business-insights.service';
import {
  BusinessInsightIdDto,
  CreateBusinessInsightDto,
  GetBusinessInsightsDto,
} from './dto/business-insight.dto';

@ApiTags('Reports')
@Controller('reports/insights')
export class BusinessInsightsController {
  constructor(private readonly insights: BusinessInsightsService) {}

  @Get('config')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  getConfiguration() {
    return this.insights.getConfiguration();
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermissions(
    PermissionKeys.REPORTS_READ,
    PermissionKeys.REPORTS_INSIGHTS_GENERATE,
  )
  create(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateBusinessInsightDto,
  ) {
    return this.insights.create(employeeId, dto);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  list(
    @Employee('employeeId') employeeId: string,
    @Query() query: GetBusinessInsightsDto,
  ) {
    return this.insights.list(employeeId, query);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  get(
    @Employee('employeeId') employeeId: string,
    @Param() { id }: BusinessInsightIdDto,
  ) {
    return this.insights.get(employeeId, id);
  }
}
