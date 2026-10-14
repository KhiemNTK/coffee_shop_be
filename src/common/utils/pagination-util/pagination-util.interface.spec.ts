import { Pagination } from './pagination-util.interface';

describe('Pagination validation', () => {
  it('coerces bounded integer query parameters and keeps existing defaults', () => {
    expect(Pagination.schema.parse({})).toEqual({ itemPerPage: 10, page: 1 });
    expect(Pagination.schema.parse({ page: '2', itemPerPage: '100' })).toEqual({
      page: 2,
      itemPerPage: 100,
    });
  });

  it.each([
    { itemPerPage: 101 },
    { itemPerPage: 1_000_000 },
    { itemPerPage: 1.5 },
    { page: 1.5 },
    { page: 1_000_001 },
    { page: 0 },
  ])('rejects invalid pagination: %p', (query) => {
    expect(Pagination.schema.safeParse(query).success).toBe(false);
  });
});
