import { TestingModule } from '@nestjs/testing';
import { PositionsService } from './positions.service';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { PositionsModule } from './positions.module';

describe('PositionsService', () => {
  let service: PositionsService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [PositionsModule],
    });

    service = module.get<PositionsService>(PositionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
