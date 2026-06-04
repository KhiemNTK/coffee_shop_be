import { TestingModule } from '@nestjs/testing';
import { PositionsController } from './positions.controller';
import { PositionsModule } from './positions.module';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';

describe('PositionsController', () => {
  let controller: PositionsController;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [PositionsModule],
    });

    controller = module.get<PositionsController>(PositionsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
