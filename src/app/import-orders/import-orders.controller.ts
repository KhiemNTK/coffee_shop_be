import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ImportOrdersService } from './import-orders.service';
import { CreateImportOrderDto } from './dto/create-import-order.dto';
import { UpdateImportOrderDto } from './dto/update-import-order.dto';

@Controller('import-orders')
export class ImportOrdersController {
  constructor(private readonly importOrdersService: ImportOrdersService) {}

  @Post()
  create(@Body() createImportOrderDto: CreateImportOrderDto) {
    return this.importOrdersService.create(createImportOrderDto);
  }

  @Get()
  findAll() {
    return this.importOrdersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.importOrdersService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateImportOrderDto: UpdateImportOrderDto) {
    return this.importOrdersService.update(+id, updateImportOrderDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.importOrdersService.remove(+id);
  }
}
