import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { Employee } from '../../common/decorators/employee.decorator';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { SkipAuth } from '../auth/auth.decorator';
import {
  CreatePromotionDto,
  GetActivePromotionsDto,
  SearchPromotionsDto,
  UpdatePromotionDto,
  UpdatePromotionStorefrontDto,
} from './dto';
import { PromotionsService } from './promotions.service';

@ApiTags('Promotions')
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get('public/featured')
  @SkipAuth()
  @Header('Cache-Control', 'no-store')
  featured() {
    return this.promotionsService.findStorefrontPromotion();
  }

  @Put(':id/storefront')
  @RequirePermissions(PermissionKeys.PROMOTIONS_UPDATE)
  updateStorefront(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() dto: UpdatePromotionStorefrontDto,
  ) {
    return this.promotionsService.updateStorefront(id, employeeId, dto);
  }

  @Post()
  @RequirePermissions(PermissionKeys.PROMOTIONS_CREATE)
  create(
    @Employee('employeeId') employeeId: string,
    @Body() createPromotionDto: CreatePromotionDto,
  ) {
    return this.promotionsService.create(employeeId, createPromotionDto);
  }

  @Get()
  @RequirePermissions(PermissionKeys.PROMOTIONS_READ)
  findAll(@Query() query: SearchPromotionsDto) {
    return this.promotionsService.findAll(query);
  }

  @Get('active')
  @RequirePermissions(PermissionKeys.PROMOTIONS_READ)
  findActive(@Query() query: GetActivePromotionsDto) {
    return this.promotionsService.findActive(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.PROMOTIONS_READ)
  findOne(@Param() { id }: IDDto) {
    return this.promotionsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.PROMOTIONS_UPDATE)
  update(
    @Param() { id }: IDDto,
    @Employee('employeeId') employeeId: string,
    @Body() updatePromotionDto: UpdatePromotionDto,
  ) {
    return this.promotionsService.update(id, employeeId, updatePromotionDto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.PROMOTIONS_DELETE)
  remove(@Param() { id }: IDDto, @Employee('employeeId') employeeId: string) {
    return this.promotionsService.remove(id, employeeId);
  }

  @Post(':id/restore')
  @RequirePermissions(PermissionKeys.PROMOTIONS_UPDATE)
  restore(@Param() { id }: IDDto, @Employee('employeeId') employeeId: string) {
    return this.promotionsService.restore(id, employeeId);
  }
}
