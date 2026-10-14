import { Test, TestingModule } from '@nestjs/testing';
import { QueryUtilService } from './query-util.service';
import { BadRequestException } from '@nestjs/common';

describe('QueryUtilService', () => {
  let service: QueryUtilService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [QueryUtilService],
    }).compile();

    service = module.get<QueryUtilService>(QueryUtilService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('allows only scalar fields belonging to the requested model', () => {
    expect(
      service.convertFieldsSelectOption('id, totalAmount,id', 'Invoice'),
    ).toEqual({
      id: true,
      totalAmount: true,
    });
    expect(
      service.convertFieldsSelectOption(undefined, 'Invoice'),
    ).toBeUndefined();
  });

  it.each([
    ['Invoice', 'employee'],
    ['Position', 'employees'],
    ['Role', 'employeeRoles'],
    ['Employee', 'password'],
    ['Employee', 'googleSubject'],
    ['Invoice', 'id,password'],
    ['Invoice', 'unknown'],
    ['Invoice', ',,'],
  ] as const)(
    'rejects %s selection %s before querying Prisma',
    (model, fields) => {
      expect(() => service.convertFieldsSelectOption(fields, model)).toThrow(
        BadRequestException,
      );
    },
  );
});
