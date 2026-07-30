import { InvoicesService } from './invoices.service';
import { InvoicesModule } from './invoices.module';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';

describe('InvoicesService', () => {
  let service: InvoicesService;

  beforeEach(async () => {
    const module = await AutoMockingModule.createTestingModule({
      imports: [InvoicesModule],
    });

    service = module.get<InvoicesService>(InvoicesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
