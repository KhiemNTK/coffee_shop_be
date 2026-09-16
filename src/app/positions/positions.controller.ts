import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { PositionsService } from './positions.service';
import { IDDto } from '../../common/dto/param.dto';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { RequirePermissions } from '../authorization/authorization.decorator';
import {
  CreatePositionDto,
  GetPositionsPaginationDto,
  UpdatePositionDto,
} from './dto';

@Controller('positions')
export class PositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  @Post()
  @RequirePermissions(PermissionKeys.POSITIONS_CREATE)
  createPosition(@Body() createPositionDto: CreatePositionDto) {
    return this.positionsService.createPosition(createPositionDto);
  }

  @Get('dropdown')
  @RequirePermissions(PermissionKeys.POSITIONS_READ)
  getPositionsDropdown() {
    return this.positionsService.getPositionsForDropdown();
  }

  @Get()
  @RequirePermissions(PermissionKeys.POSITIONS_READ)
  getPositions(@Query() query: GetPositionsPaginationDto) {
    return this.positionsService.getPositions(query);
  }

  @Get(':id')
  @RequirePermissions(PermissionKeys.POSITIONS_READ)
  getPositionById(@Param() { id }: IDDto) {
    return this.positionsService.getPositionById(id);
  }

  @Patch(':id')
  @RequirePermissions(PermissionKeys.POSITIONS_UPDATE)
  updatePosition(
    @Param() { id }: IDDto,
    @Body() updatePositionDto: UpdatePositionDto,
  ) {
    return this.positionsService.updatePosition(id, updatePositionDto);
  }

  @Delete(':id')
  @RequirePermissions(PermissionKeys.POSITIONS_DELETE)
  deletePosition(@Param() { id }: IDDto) {
    return this.positionsService.deletePosition(id);
  }
}
