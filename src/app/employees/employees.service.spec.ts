import { TestingModule } from '@nestjs/testing';
import { EmployeesService } from './employees.service';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { EmployeesModule } from './employees.module';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';

describe('EmployeesService', () => {
  let service: EmployeesService;
  let employeeCreate: jest.Mock;
  let stringUtilService: StringUtilService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [EmployeesModule],
    });

    service = module.get<EmployeesService>(EmployeesService);
    stringUtilService = module.get(StringUtilService);
    employeeCreate = jest.fn();
    const prisma = module.get<Record<string, unknown>>(PRISMA_SERVICE_TOKEN);
    prisma.employee = { create: employeeCreate };
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('hashes a password before creating an employee', async () => {
    jest.spyOn(stringUtilService, 'hash').mockResolvedValue('password-hash');
    employeeCreate.mockResolvedValue({ id: 'employee-1' });

    await service.createEmployee({
      email: 'employee@example.com',
      username: 'employee',
      fullName: 'Employee',
      password: 'correct-horse-battery-staple',
      positionId: 'a15d0c7c-cfb3-4bd4-a039-25e01184f19d',
      isActive: true,
    });

    expect(employeeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ password: 'password-hash' }),
        select: expect.not.objectContaining({ password: true }),
      }),
    );
    expect(employeeCreate.mock.calls[0][0].data.password).not.toBe(
      'correct-horse-battery-staple',
    );
  });
});
