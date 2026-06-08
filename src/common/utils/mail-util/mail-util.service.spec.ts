import { TestingModule } from '@nestjs/testing';
import { MailUtilService } from './mail-util.service';
import { AutoMockingModule } from '../../../../test/auto-mocking/auto-mocking.module';
import { MailUtilModule } from './mail-util.module';

describe('AuthService', () => {
  let service: MailUtilService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [MailUtilModule],
    });

    service = module.get<MailUtilService>(MailUtilService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
