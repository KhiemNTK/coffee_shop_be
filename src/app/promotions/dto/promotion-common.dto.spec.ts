import { SearchPromotionsSchema } from './promotion-common.dto';

describe('SearchPromotionsSchema', () => {
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
