import 'multer';

export interface GenerateExcelParams {
  worksheets: {
    sheetName: string;
    data: any[];
    fieldsExclude?: string[];
    fieldsMapping?: Record<string, string>;
    fieldsExtend?: string[];
  }[];
}

export type File = Express.Multer.File;
