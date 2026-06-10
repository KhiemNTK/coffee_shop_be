import { EmployeeInfo } from '../../../decorators/employee.decorator';
import { File } from './excel-util.interface';

class ImportExcel {
  file!: File;
  employee!: EmployeeInfo;
}

enum ColumnExport {
  REQUIRE_FIELDS = 'REQUIRE_FIELDS',
}

export { ImportExcel, ColumnExport };
