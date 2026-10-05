import { TestingModule } from '@nestjs/testing';
import { EmployeesService } from './employees.service';
import { AutoMockingModule } from '../../../test/auto-mocking/auto-mocking.module';
import { EmployeesModule } from './employees.module';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { GetEmployeesPaginationDto } from './dto';

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

  it('validates paging and preserves false instead of coercing it to true', () => {
    expect(
      GetEmployeesPaginationDto.schema.parse({
        isActive: 'false',
        search: '  cashier  ',
      }),
    ).toMatchObject({
      isActive: false,
      search: 'cashier',
      page: 1,
      itemPerPage: 10,
    });
    for (const input of [
      { isActive: 'invalid' },
      { page: 1.5 },
      { itemPerPage: 101 },
      { positionId: 'invalid' },
    ]) {
      expect(GetEmployeesPaginationDto.schema.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it('combines global search and exact filters before paging with a stable order', async () => {
    const prisma = {
      employee: {
        count: jest.fn().mockResolvedValue(21),
        findMany: jest.fn().mockResolvedValue([{ id: 'employee-21' }]),
      },
    };
    const subject = new EmployeesService(
      prisma as never,
      new PaginationUtilService(),
      {} as never,
      {} as never,
    );
    const positionId = 'a15d0c7c-cfb3-4bd4-a039-25e01184f19d';
    const query = GetEmployeesPaginationDto.schema.parse({
      page: 2,
      itemPerPage: 20,
      search: 'cashier',
      isActive: 'false',
      positionId,
    });
    const result = await subject.getEmployees(query);
    const where = {
      deletedAt: null,
      isActive: false,
      positionId,
      OR: ['fullName', 'username', 'email'].map((field) => ({
        [field]: { contains: 'cashier', mode: 'insensitive' },
      })),
    };
    expect(prisma.employee.count).toHaveBeenCalledWith({ where });
    expect(prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        skip: 20,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
    expect(result).toMatchObject({
      currentPage: 2,
      totalItems: 21,
      totalPages: 2,
    });
    expect(prisma.employee.findMany.mock.calls[0][0].select).not.toHaveProperty(
      'password',
    );
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
