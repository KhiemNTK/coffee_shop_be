import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Employee } from '../../common/decorators/employee.decorator';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CancelReservationDto,
  CreateReservationDto,
  GetReservationsDto,
  ReservationIdDto,
  UpdateReservationDto,
} from './dto';
import { ReservationsService } from './reservations.service';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  @RequirePermissions(PermissionKeys.RESERVATIONS_CREATE)
  create(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateReservationDto,
  ) {
    return this.reservationsService.create(employeeId, dto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.RESERVATIONS_READ)
  findAll(@Query() query: GetReservationsDto) {
    return this.reservationsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.RESERVATIONS_READ)
  findOne(@Param() { id }: ReservationIdDto) {
    return this.reservationsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.RESERVATIONS_UPDATE)
  update(
    @Param() { id }: ReservationIdDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateReservationDto,
  ) {
    return this.reservationsService.update(id, employeeId, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions(PermissionKeys.RESERVATIONS_CANCEL)
  cancel(
    @Param() { id }: ReservationIdDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: CancelReservationDto,
  ) {
    return this.reservationsService.cancel(id, employeeId, dto);
  }

  @Post(':id/check-in')
  @RequirePermissions(PermissionKeys.RESERVATIONS_CHECK_IN)
  checkIn(
    @Param() { id }: ReservationIdDto,
    @Employee('employeeId') employeeId: string,
  ) {
    return this.reservationsService.checkIn(id, employeeId);
  }
}
