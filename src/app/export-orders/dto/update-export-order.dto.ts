import { PartialType } from '@nestjs/mapped-types';
import { CreateExportOrderDto } from './create-export-order.dto';

export class UpdateExportOrderDto extends PartialType(CreateExportOrderDto) {}
