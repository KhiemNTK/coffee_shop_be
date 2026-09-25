import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CreatePrintDeviceDto,
  GetPrintDevicesDto,
  GetPrintJobsDto,
  ReprintReceiptDto,
  RetryPrintJobDto,
  UpdatePrintDeviceDto,
} from './dto';
import { PrintingService } from './printing.service';

@ApiTags('printing')
@Controller('printing')
export class PrintingController {
  constructor(private readonly printing: PrintingService) {}

  @Post('devices')
  @RequirePermissions(PermissionKeys.PRINT_DEVICES_MANAGE)
  createDevice(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreatePrintDeviceDto,
  ) {
    return this.printing.createDevice(employeeId, dto);
  }

  @Get('devices')
  @RequirePermissions(PermissionKeys.PRINT_DEVICES_READ)
  getDevices(@Query() query: GetPrintDevicesDto) {
    return this.printing.getDevices(query);
  }

  @Get('devices/:id')
  @RequirePermissions(PermissionKeys.PRINT_DEVICES_READ)
  getDevice(@Param() { id }: IDDto) {
    return this.printing.getDevice(id);
  }

  @Patch('devices/:id')
  @RequirePermissions(PermissionKeys.PRINT_DEVICES_MANAGE)
  updateDevice(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdatePrintDeviceDto,
  ) {
    return this.printing.updateDevice(id, employeeId, dto);
  }

  @Delete('devices/:id')
  @RequirePermissions(PermissionKeys.PRINT_DEVICES_MANAGE)
  deleteDevice(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.printing.deleteDevice(id, employeeId);
  }

  @Post('devices/:id/rotate-key')
  @RequirePermissions(PermissionKeys.PRINT_DEVICES_MANAGE)
  rotateDeviceKey(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.printing.rotateDeviceKey(id, employeeId);
  }

  @Get('jobs')
  @RequirePermissions(PermissionKeys.PRINT_JOBS_READ)
  getJobs(@Query() query: GetPrintJobsDto) {
    return this.printing.getJobs(query);
  }

  @Get('jobs/:id')
  @RequirePermissions(PermissionKeys.PRINT_JOBS_READ)
  getJob(@Param() { id }: IDDto) {
    return this.printing.getJob(id);
  }

  @Post('jobs/:id/retry')
  @RequirePermissions(PermissionKeys.PRINT_JOBS_MANAGE)
  retryJob(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: RetryPrintJobDto,
  ) {
    return this.printing.retryJob(id, employeeId, dto);
  }

  @Post('invoices/:id/reprint')
  @RequirePermissions(PermissionKeys.RECEIPTS_REPRINT)
  reprintReceipt(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: ReprintReceiptDto,
  ) {
    return this.printing.reprintReceipt(id, employeeId, dto);
  }
}
