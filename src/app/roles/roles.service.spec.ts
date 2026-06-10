import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { RolesModule } from './roles.module';
import { RolesService } from './roles.service';

describe('RoleService', () => {
  let service: RolesService;

  beforeEach(async () => {
    const module = await AutoMockingModule.createTestingModule({
      imports: [RolesModule],
    });

    service = await module.resolve<RolesService>(RolesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
