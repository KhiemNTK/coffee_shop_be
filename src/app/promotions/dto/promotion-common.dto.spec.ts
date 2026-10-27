import { SearchPromotionsSchema } from './promotion-common.dto';

describe('SearchPromotionsSchema', () => {
  it.each([
    { page: '1.5' },
    { itemPerPage: '2.5' },
    { page: '1000001' },
    { page: '0' },
    { itemPerPage: '101' },
  ])('rejects invalid pagination: %p', (input) => {
    expect(SearchPromotionsSchema.safeParse(input).success).toBe(false);
  });

  it('normalizes integer query parameters and retains the existing defaults', () => {
    expect(
      SearchPromotionsSchema.parse({ page: '2', itemPerPage: '25' }),
    ).toMatchObject({ page: 2, itemPerPage: 25 });
    expect(SearchPromotionsSchema.parse({})).toMatchObject({
      page: 1,
      itemPerPage: 20,
    });
  });
  it.each([
    ['false', false],
    ['true', true],
    [false, false],
    [true, true],
    [undefined, false],
  ])('parses includeDeleted=%s as %s', (value, expected) => {
    expect(
      SearchPromotionsSchema.parse({ includeDeleted: value }).includeDeleted,
    ).toBe(expected);
  });

  it('rejects an unknown boolean value', () => {
    expect(
      SearchPromotionsSchema.safeParse({ includeDeleted: 'invalid' }).success,
    ).toBe(false);
  });
});
