import type { EmployeeInfo } from '../../../types';
import { File } from './excel-util.interface';

class ImportExcel {
  file!: File;
  employee!: EmployeeInfo;
}

export { ImportExcel };
