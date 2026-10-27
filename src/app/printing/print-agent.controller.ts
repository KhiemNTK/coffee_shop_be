import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedPrintDevice } from '../../common/types';
import { IDDto } from '../../common/dto/param.dto';
import { SkipAuth } from '../auth/auth.decorator';
import {
  ClaimPrintJobsDto,
  CompletePrintJobDto,
  FailPrintJobDto,
  PrintAgentHeartbeatDto,
} from './dto';
import { CurrentPrintDevice } from './print-device.decorator';
import { PrintDeviceGuard } from './print-device.guard';
import { PrintingService } from './printing.service';

@ApiTags('Print Agent')
@ApiHeader({ name: 'X-Print-Device-Id', required: true })
@ApiHeader({ name: 'X-Print-Device-Key', required: true })
@Controller('print-agent')
@SkipAuth()
@UseGuards(PrintDeviceGuard)
export class PrintAgentController {
  constructor(private readonly printing: PrintingService) {}

  @Post('heartbeat')
  heartbeat(
    @CurrentPrintDevice() device: AuthenticatedPrintDevice,
    @Body() dto: PrintAgentHeartbeatDto,
  ) {
    return this.printing.heartbeat(device, dto);
  }

  @Post('jobs/claim')
  claimJobs(
    @CurrentPrintDevice() device: AuthenticatedPrintDevice,
    @Body() dto: ClaimPrintJobsDto,
  ) {
    return this.printing.claimJobs(device, dto);
  }

  @Post('jobs/:id/complete')
  completeJob(
    @CurrentPrintDevice() device: AuthenticatedPrintDevice,
    @Param() { id }: IDDto,
    @Body() dto: CompletePrintJobDto,
  ) {
    return this.printing.completeJob(device.id, id, dto.leaseToken);
  }

  @Get('jobs/:id')
  getJobStatus(
    @CurrentPrintDevice() device: AuthenticatedPrintDevice,
    @Param() { id }: IDDto,
  ) {
    return this.printing.getAgentJob(device.id, id);
  }

  @Post('jobs/:id/fail')
  failJob(
    @CurrentPrintDevice() device: AuthenticatedPrintDevice,
    @Param() { id }: IDDto,
    @Body() dto: FailPrintJobDto,
  ) {
    return this.printing.failJob(
      device.id,
      id,
      dto.leaseToken,
      dto.error,
      dto.outcome,
    );
  }
}
