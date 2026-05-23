import { Injectable } from '@nestjs/common';
import { CreateDiningTableDto } from './dto/create-dining-table.dto';
import { UpdateDiningTableDto } from './dto/update-dining-table.dto';

@Injectable()
export class DiningTablesService {
  create(createDiningTableDto: CreateDiningTableDto) {
    return 'This action adds a new diningTable';
  }

  findAll() {
    return `This action returns all diningTables`;
  }

  findOne(id: number) {
    return `This action returns a #${id} diningTable`;
  }

  update(id: number, updateDiningTableDto: UpdateDiningTableDto) {
    return `This action updates a #${id} diningTable`;
  }

  remove(id: number) {
    return `This action removes a #${id} diningTable`;
  }
}
