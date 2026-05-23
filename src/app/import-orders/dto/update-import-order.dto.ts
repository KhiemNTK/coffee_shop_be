import { PartialType } from '@nestjs/mapped-types';
import { CreateImportOrderDto } from './create-import-order.dto';

export class UpdateImportOrderDto extends PartialType(CreateImportOrderDto) {}
