import { TestingModule } from '@nestjs/testing';
import { RolesController } from './roles.controller';
import { RolesModule } from './roles.module';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';

describe('PositionsController', () => {
  let controller: RolesController;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [RolesModule],
    });

    controller = module.get<RolesController>(RolesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
