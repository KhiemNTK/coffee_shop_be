import { Injectable } from '@nestjs/common';
import { CreateImportOrderDto } from './dto/create-import-order.dto';
import { UpdateImportOrderDto } from './dto/update-import-order.dto';

@Injectable()
export class ImportOrdersService {
  create(createImportOrderDto: CreateImportOrderDto) {
    return 'This action adds a new importOrder';
  }

  findAll() {
    return `This action returns all importOrders`;
  }

  findOne(id: number) {
    return `This action returns a #${id} importOrder`;
  }

  update(id: number, updateImportOrderDto: UpdateImportOrderDto) {
    return `This action updates a #${id} importOrder`;
  }

  remove(id: number) {
    return `This action removes a #${id} importOrder`;
  }
}
