import { CatchEverythingFilter } from './catch-everything.filter';
import { AutoMockingModule } from '../../test/auto-mocking/auto-mocking.module';

describe('CatchEverythingFilter', () => {
  let filter: CatchEverythingFilter;

  beforeEach(async () => {
    const module = await AutoMockingModule.createTestingModule({
      providers: [CatchEverythingFilter],
    });

    filter = module.get<CatchEverythingFilter>(CatchEverythingFilter);
  });

  it('should be defined', () => {
    expect(filter).toBeDefined();
  });
});
