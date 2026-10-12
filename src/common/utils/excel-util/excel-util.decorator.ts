import {
  applyDecorators,
  BadRequestException,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiBody, ApiProduces } from '@nestjs/swagger';
import { ExcelResponseInterceptor } from '../../../common/interceptors/excel-response/excel-response.interceptor';
import { EXCEL_IMPORT_LIMITS } from './excel-import-limits';

export const ImportExcel = () => {
  return applyDecorators(
    UseInterceptors(
      FileInterceptor('file', {
        limits: {
          fileSize: EXCEL_IMPORT_LIMITS.fileSize,
          files: EXCEL_IMPORT_LIMITS.files,
          parts: EXCEL_IMPORT_LIMITS.parts,
          fields: EXCEL_IMPORT_LIMITS.fields,
        },
        fileFilter: (req, file, cb) => {
          const isExcelExtension = file.originalname.match(/\.(xlsx)$/i);
          const isExcelMimeType =
            file.mimetype ===
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

          if (!isExcelExtension || !isExcelMimeType) {
            return cb(
              new BadRequestException('Only support file Excel (.xlsx)'),
              false,
            );
          }
          cb(null, true);
        },
      }),
    ),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      description: 'Upload file import',
      required: true,
      schema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            format: 'binary',
          },
        },
      },
    }),
  );
};

export const ExportExcel = () => {
  return applyDecorators(
    UseInterceptors(ExcelResponseInterceptor),
    ApiProduces(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ),
  );
};
