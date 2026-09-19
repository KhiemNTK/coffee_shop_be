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
import { CreateFundDto, GetFundsDto, UpdateFundDto } from './dto';
import { FundsService } from './funds.service';

@ApiTags('funds')
@Controller('funds')
export class FundsController {
  constructor(private readonly fundsService: FundsService) {}

  @Post()
  @RequirePermissions(PermissionKeys.FUNDS_MANAGE)
  create(
    @Employee('employeeId') employeeId: string,
    @Body() dto: CreateFundDto,
  ) {
    return this.fundsService.create(employeeId, dto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.FUNDS_READ)
  findAll(@Query() query: GetFundsDto) {
    return this.fundsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.FUNDS_READ)
  findOne(@Param() { id }: IDDto) {
    return this.fundsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.FUNDS_MANAGE)
  update(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdateFundDto,
  ) {
    return this.fundsService.update(id, employeeId, dto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.FUNDS_MANAGE)
  remove(@Param() { id }: IDDto, @Employee('employeeId') employeeId: string) {
    return this.fundsService.remove(id, employeeId);
  }
}
