import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Employee } from '../../common/decorators/employee.decorator';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { SkipAuth } from '../auth/auth.decorator';
import {
  ApproveReservationRequestDto,
  CancelReservationDto,
  CreatePublicReservationRequestDto,
  CreateReservationDto,
  GetReservationRequestsDto,
  GetReservationsDto,
  RejectReservationRequestDto,
  ReservationIdDto,
  ReservationRequestIdDto,
  TrackPublicReservationRequestDto,
  UpdateReservationDto,
} from './dto';
import { ReservationsService } from './reservations.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post('public/requests')
  @SkipAuth()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  createPublicRequest(
    @Body() dto: CreatePublicReservationRequestDto,
    @Req() req: Request,
  ) {
    return this.reservationsService.createPublicRequest(dto, req.ip);
  }

  @Post('public/requests/status')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  trackPublicRequest(
    @Body() { accessToken }: TrackPublicReservationRequestDto,
  ) {
    return this.reservationsService.trackPublicRequest(accessToken);
  }

  @Post('public/requests/cancel')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  cancelPublicRequest(
    @Body() { accessToken }: TrackPublicReservationRequestDto,
  ) {
    return this.reservationsService.cancelPublicRequest(accessToken);
  }

  @Get('requests')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PermissionKeys.RESERVATIONS_READ)
  getRequests(@Query() query: GetReservationRequestsDto) {
    return this.reservationsService.findRequests(query);
  }

  @Get('requests/:id')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PermissionKeys.RESERVATIONS_READ)
  getRequest(@Param() { id }: ReservationRequestIdDto) {
    return this.reservationsService.findRequest(id);
  }

  @Post('requests/:id/approve')
  @RequirePermissions(PermissionKeys.RESERVATIONS_CREATE)
  approveRequest(
    @Param() { id }: ReservationRequestIdDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: ApproveReservationRequestDto,
  ) {
    return this.reservationsService.approveRequest(id, employeeId, dto);
  }

  @Post('requests/:id/reject')
  @RequirePermissions(PermissionKeys.RESERVATIONS_UPDATE)
  rejectRequest(
    @Param() { id }: ReservationRequestIdDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: RejectReservationRequestDto,
  ) {
    return this.reservationsService.rejectRequest(id, employeeId, dto);
  }

  @Post()
  @RequirePermissions(PermissionKeys.RESERVATIONS_CREATE)
  create(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateReservationDto,
  ) {
    return this.reservationsService.create(employeeId, dto);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PermissionKeys.RESERVATIONS_READ)
  findAll(@Query() query: GetReservationsDto) {
    return this.reservationsService.findAll(query);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
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
