import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ExportOrdersService } from './export-orders.service';
import { CreateExportOrderDto } from './dto/create-export-order.dto';
import { UpdateExportOrderDto } from './dto/update-export-order.dto';

@Controller('export-orders')
export class ExportOrdersController {
  constructor(private readonly exportOrdersService: ExportOrdersService) {}

  @Post()
  create(@Body() createExportOrderDto: CreateExportOrderDto) {
    return this.exportOrdersService.create(createExportOrderDto);
  }

  @Get()
  findAll() {
    return this.exportOrdersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.exportOrdersService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateExportOrderDto: UpdateExportOrderDto) {
    return this.exportOrdersService.update(+id, updateExportOrderDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.exportOrdersService.remove(+id);
  }
}
