import { TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { AuthModule } from './auth.module';

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [AuthModule],
    });

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
