import { Test, TestingModule } from '@nestjs/testing';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { ConfigService } from '@nestjs/config';
import { MenuImagesService } from './menu-images.service';

describe('MenuController', () => {
  let controller: MenuController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MenuController],
      providers: [
        { provide: MenuService, useValue: {} },
        {
          provide: MenuImagesService,
          useValue: { policy: () => ({ enabled: false }), upload: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            SHOP_NAME: 'Actual shop',
            SHOP_ADDRESS: null,
            SHOP_PHONE: '0901234567',
            JWT_SECRET: 'must-not-be-public',
          }),
        },
      ],
    }).compile();

    controller = module.get<MenuController>(MenuController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('projects only public shop identity, never secrets', () => {
    expect(controller.getPublicStore()).toEqual({
      name: 'Actual shop',
      address: null,
      phone: '0901234567',
    });
  });
});
