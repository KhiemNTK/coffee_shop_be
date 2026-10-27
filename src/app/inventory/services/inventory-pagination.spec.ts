import { PaginationUtilService } from '../../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../../common/utils/query-util/query-util.service';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryCategoryService } from './inventory-category.service';
import { UnitService } from './unit.service';

describe('Inventory pagination order', () => {
  it.each(['items', 'categories', 'units'])(
    'uses a unique tie-breaker for %s',
    async (kind) => {
      const model = {
        count: jest.fn().mockResolvedValue(32),
        findMany: jest.fn().mockResolvedValue([]),
      };
      const repository = {
        client: { inventoryItem: model, inventoryCategory: model, unit: model },
      };
      const pagination = new PaginationUtilService();
      const query = new QueryUtilService();
      if (kind === 'items') {
        await new InventoryQueryService(
          repository as never,
          pagination,
          query,
        ).findItems({ page: 2, itemPerPage: 10, lowStockOnly: false });
      } else if (kind === 'categories') {
        await new InventoryCategoryService(
          repository as never,
          pagination,
          query,
          {} as never,
          {} as never,
          {} as never,
        ).findAll({ page: 2, itemPerPage: 10 });
      } else {
        await new UnitService(
          repository as never,
          pagination,
          query,
          {} as never,
          {} as never,
          {} as never,
        ).findAll({ page: 2, itemPerPage: 10 });
      }
      expect(model.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        }),
      );
    },
  );
});
