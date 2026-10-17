import { BadRequestException, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MENU_IMAGE_MAX_BYTES } from '../../common/consts/menu-images';
import { AuthorizationService } from '../authorization/authorization.service';
import { PermissionsGuard } from '../authorization/permissions.guard';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { MenuImagesService } from './menu-images.service';

describe('Menu image HTTP contract', () => {
  let app: INestApplication<App>;
  let keys: string[];
  const upload = jest.fn((_employeeId: string, file?: Express.Multer.File) => {
    if (!file) throw new BadRequestException({ code: 'IMAGE_UPLOAD_INVALID' });
    return { id: 'upload', bytes: file.buffer.length };
  });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MenuController],
      providers: [
        { provide: MenuService, useValue: {} },
        { provide: ConfigService, useValue: new ConfigService() },
        {
          provide: MenuImagesService,
          useValue: { upload, policy: () => ({ enabled: false }) },
        },
        {
          provide: AuthorizationService,
          useValue: {
            getAuthorizationContext: () =>
              Promise.resolve({ permissionKeys: keys, roleNames: [] }),
          },
        },
        PermissionsGuard,
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(
      (
        req: { employee: { employeeId: string } },
        _res: unknown,
        next: () => void,
      ) => {
        req.employee = { employeeId: 'actor' };
        next();
      },
    );
    app.useGlobalGuards(module.get(PermissionsGuard));
    await app.init();
  });
  beforeEach(() => {
    keys = ['/menu_read'];
    upload.mockClear();
  });
  afterAll(async () => {
    await app.close();
  });

  it('requires read permission for policy and no upload permission is implied by read', async () => {
    await request(app.getHttpServer())
      .get('/menu/images/policy')
      .expect(200, { enabled: false });
    await request(app.getHttpServer())
      .post('/menu/images/create')
      .attach('file', Buffer.from('fixture'), 'image.png')
      .expect(403);
    expect(upload).not.toHaveBeenCalled();
  });
  it.each(['create', 'update'])(
    'checks the exact %s permission before parsing the file',
    async (purpose) => {
      keys = [`/menu_${purpose}`];
      await request(app.getHttpServer())
        .post(`/menu/images/${purpose}`)
        .attach('file', Buffer.from('fixture'), 'image.png')
        .expect(201);
      expect(upload).toHaveBeenCalledWith(
        'actor',
        expect.objectContaining({
          mimetype: 'image/png',
          buffer: Buffer.from('fixture'),
        }),
      );
      await request(app.getHttpServer())
        .post(`/menu/images/${purpose === 'create' ? 'update' : 'create'}`)
        .attach('file', Buffer.from('fixture'), 'image.png')
        .expect(403);
    },
  );
  it('rejects missing, unsupported, extra and oversized multipart fields', async () => {
    keys = ['/menu_create'];
    await request(app.getHttpServer()).post('/menu/images/create').expect(400);
    await request(app.getHttpServer())
      .post('/menu/images/create')
      .attach('file', Buffer.from('<svg/>'), 'image.svg')
      .expect(400);
    await request(app.getHttpServer())
      .post('/menu/images/create')
      .attach('file', Buffer.from('fixture'), 'image.png')
      .attach('file', Buffer.from('fixture'), 'other.png')
      .expect(400);
    await request(app.getHttpServer())
      .post('/menu/images/create')
      .field('bucket', 'other')
      .attach('file', Buffer.from('fixture'), 'image.png')
      .expect(400);
    await request(app.getHttpServer())
      .post('/menu/images/create')
      .attach('file', Buffer.alloc(MENU_IMAGE_MAX_BYTES + 1), 'image.png')
      .expect(413);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
