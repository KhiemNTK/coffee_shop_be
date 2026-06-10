import 'multer';

interface GenerateExcelParams {
  worksheets: {
    sheetName: string;
    data: any[];
    fieldsExclude?: string[];
    fieldsMapping?: Record<string, string>;
    fieldsExtend?: string[];
  }[];
}

type File = Express.Multer.File;

export type { File, GenerateExcelParams };
