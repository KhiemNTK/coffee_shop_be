import { Test, TestingModule } from '@nestjs/testing';
import { DateUtilService } from '../../common/utils/date-util/date-util.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { DailySalesCloseService } from './daily-sales-close.service';

describe('ReportsController', () => {
  let controller: ReportsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        { provide: ReportsService, useValue: {} },
        { provide: DailySalesCloseService, useValue: {} },
        { provide: DateUtilService, useValue: {} },
      ],
    }).compile();

    controller = module.get<ReportsController>(ReportsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
