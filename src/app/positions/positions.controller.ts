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
import { CreatePositionDto } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';
import { IDDto } from '../../common/dto/param.dto';
import { GetPositionsPaginationDto } from './dto/get-position.dto';

@Controller('positions')
export class PositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  @Post()
  createPosition(@Body() createPositionDto: CreatePositionDto) {
    return this.positionsService.createPosition(createPositionDto);
  }

  @Get('dropdown')
  getPositionsDropdown() {
    return this.positionsService.getPositionsForDropdown();
  }

  @Get()
  getPositions(@Query() query: GetPositionsPaginationDto) {
    return this.positionsService.getPositions(query);
  }

  @Get(':id')
  getPositionById(@Param() { id }: IDDto) {
    return this.positionsService.getPositionById(id);
  }

  @Patch(':id')
  updatePosition(
    @Param() { id }: IDDto,
    @Body() updatePositionDto: UpdatePositionDto,
  ) {
    return this.positionsService.updatePosition(id, updatePositionDto);
  }

  @Delete(':id')
  deletePosition(@Param() { id }: IDDto) {
    return this.positionsService.deletePosition(id);
  }
}
