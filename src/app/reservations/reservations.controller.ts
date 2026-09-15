import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  @RequirePermissions(PermissionKeys.RESERVATIONS_CREATE)
  create(@Body() createReservationDto: CreateReservationDto) {
    return this.reservationsService.create(createReservationDto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.RESERVATIONS_READ)
  findAll() {
    return this.reservationsService.findAll();
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.RESERVATIONS_READ)
  findOne(@Param('id') id: string) {
    return this.reservationsService.findOne(+id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.RESERVATIONS_UPDATE)
  update(
    @Param('id') id: string,
    @Body() updateReservationDto: UpdateReservationDto,
  ) {
    return this.reservationsService.update(+id, updateReservationDto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.RESERVATIONS_DELETE)
  remove(@Param('id') id: string) {
    return this.reservationsService.remove(+id);
  }
}
