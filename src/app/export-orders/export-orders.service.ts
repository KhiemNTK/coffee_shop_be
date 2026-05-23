import { Injectable } from '@nestjs/common';
import { CreateExportOrderDto } from './dto/create-export-order.dto';
import { UpdateExportOrderDto } from './dto/update-export-order.dto';

@Injectable()
export class ExportOrdersService {
  create(createExportOrderDto: CreateExportOrderDto) {
    return 'This action adds a new exportOrder';
  }

  findAll() {
    return `This action returns all exportOrders`;
  }

  findOne(id: number) {
    return `This action returns a #${id} exportOrder`;
  }

  update(id: number, updateExportOrderDto: UpdateExportOrderDto) {
    return `This action updates a #${id} exportOrder`;
  }

  remove(id: number) {
    return `This action removes a #${id} exportOrder`;
  }
}
