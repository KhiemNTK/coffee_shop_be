import { Test, TestingModule } from '@nestjs/testing';
import { StringUtilService } from './string-util.service';

describe('StringUtilService', () => {
  let service: StringUtilService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StringUtilService],
    }).compile();

    service = module.get<StringUtilService>(StringUtilService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
