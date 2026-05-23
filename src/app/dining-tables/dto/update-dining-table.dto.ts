import { PartialType } from '@nestjs/mapped-types';
import { CreateDiningTableDto } from './create-dining-table.dto';

export class UpdateDiningTableDto extends PartialType(CreateDiningTableDto) {}
