import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { SearchPromotionsDto } from '../dto/promotion-common.dto';
import type { PromotionsRepository } from '../repositories/promotions.repository';
import type { PromotionCalculatorService } from './promotion-calculator.service';
import { PromotionQueryService } from './promotion-query.service';

describe('PromotionQueryService sorting', () => {
  it.each(['name', 'startDate', 'endDate', 'createdAt', 'updatedAt'])(
    'adds a unique tie-breaker when sorting by %s',
    async (sortBy) => {
      const promotion = {
        count: jest.fn().mockResolvedValue(25),
        findMany: jest.fn().mockResolvedValue([]),
      };
      const service = new PromotionQueryService(
        { client: { promotion } } as unknown as PromotionsRepository,
        new PaginationUtilService(),
        {} as PromotionCalculatorService,
      );

      for (const sortOrder of ['asc', 'desc']) {
        const result = await service.search(
          SearchPromotionsDto.schema.parse({
            page: 2,
            itemPerPage: 12,
            sortBy,
            sortOrder,
          }),
        );
        expect(promotion.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            skip: 12,
            take: 12,
            orderBy: [{ [sortBy]: sortOrder }, { id: 'asc' }],
          }),
        );
        expect(result).toMatchObject({ currentPage: 2, totalPages: 3 });
      }
    },
  );
});
