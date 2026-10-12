import {
  Controller,
  type INestApplication,
  Post,
  UploadedFile,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ImportExcel } from './excel-util.decorator';
import { EXCEL_IMPORT_LIMITS } from './excel-import-limits';

const imported = jest.fn();
const mimeType =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller('excel')
class ImportController {
  @Post()
  @ImportExcel()
  import(@UploadedFile() file: Express.Multer.File) {
    imported(file);
    return { size: file.buffer.length };
  }
}

describe('ImportExcel multipart limits', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ImportController],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  beforeEach(() => imported.mockClear());
  afterAll(async () => app.close());

  it('accepts a single file below the upload size ceiling', async () => {
    await request(app.getHttpServer())
      .post('/excel')
      .attach('file', Buffer.alloc(EXCEL_IMPORT_LIMITS.fileSize - 1), {
        filename: 'roles.xlsx',
        contentType: mimeType,
      })
      .expect(201);
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it('rejects excess file bytes before the controller runs', async () => {
    await request(app.getHttpServer())
      .post('/excel')
      .attach('file', Buffer.alloc(EXCEL_IMPORT_LIMITS.fileSize + 1), {
        filename: 'roles.xlsx',
        contentType: mimeType,
      })
      .expect(413);
    expect(imported).not.toHaveBeenCalled();
  });

  it('rejects multiple files before the controller runs', async () => {
    await request(app.getHttpServer())
      .post('/excel')
      .attach('file', Buffer.from('first'), {
        filename: 'roles.xlsx',
        contentType: mimeType,
      })
      .attach('file', Buffer.from('second'), {
        filename: 'more.xlsx',
        contentType: mimeType,
      })
      .expect(400);
    expect(imported).not.toHaveBeenCalled();
  });

  it('rejects extra form parts before the controller runs', async () => {
    await request(app.getHttpServer())
      .post('/excel')
      .attach('file', Buffer.from('first'), {
        filename: 'roles.xlsx',
        contentType: mimeType,
      })
      .field('isSystemRole', 'true')
      .expect(400);
    expect(imported).not.toHaveBeenCalled();
  });

  it.each([
    ['roles.csv', mimeType],
    ['roles.xlsx', 'text/plain'],
  ])(
    'retains extension/MIME validation for %s (%s)',
    async (filename, contentType) => {
      await request(app.getHttpServer())
        .post('/excel')
        .attach('file', Buffer.from('invalid'), { filename, contentType })
        .expect(400);
      expect(imported).not.toHaveBeenCalled();
    },
  );
});
