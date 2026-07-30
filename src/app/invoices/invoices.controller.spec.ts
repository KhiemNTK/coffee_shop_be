import { InvoicesController } from './invoices.controller';
import { InvoicesModule } from './invoices.module';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';

describe('InvoicesController', () => {
  let controller: InvoicesController;

  beforeEach(async () => {
    const module = await AutoMockingModule.createTestingModule({
      imports: [InvoicesModule],
    });

    controller = module.get<InvoicesController>(InvoicesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
