import {
  evaluateRecommendations,
  RecommendationEvaluationSchema,
} from './recommendation-evaluation';

const dataset = () => ({
  schemaVersion: 1,
  trainFrom: '2026-01-01T00:00:00Z',
  splitAt: '2026-01-08T00:00:00Z',
  testTo: '2026-01-10T00:00:00Z',
  availableMenuItemIds: ['a', 'b', 'c', 'd', 'e'],
  baskets: [
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `pair-${i}`,
      createdAt: '2026-01-02T00:00:00Z',
      menuItemIds: ['a', 'b'],
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `popular-${i}`,
      createdAt: '2026-01-03T00:00:00Z',
      menuItemIds: ['c', 'd', 'e'],
    })),
    {
      id: 'held-out',
      createdAt: '2026-01-08T00:00:00Z',
      menuItemIds: ['a', 'b'],
    },
  ],
});

describe('offline recommendation evaluation', () => {
  it('uses training-only pairs and compares the serving ranker with popular items', () => {
    const input = dataset();
    const result = evaluateRecommendations(input);
    expect(result).toMatchObject({
      trainingBaskets: 7,
      evaluatedBaskets: 1,
      models: {
        coPurchase: { hitRateAt3: 1, meanReciprocalRankAt3: 1 },
        popular: { hitRateAt3: 0 },
      },
    });
    expect(
      evaluateRecommendations({
        ...input,
        baskets: [...input.baskets].reverse(),
      }),
    ).toEqual(result);
  });

  it('does not learn a pair from held-out test orders, including the split boundary', () => {
    const input = dataset();
    input.baskets = input.baskets.filter(
      (basket) => !basket.id.startsWith('pair'),
    );
    input.baskets.push(
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `future-${i}`,
        createdAt: input.splitAt,
        menuItemIds: ['a', 'b'],
      })),
    );
    expect(evaluateRecommendations(input)).toMatchObject({
      coldTargets: 9,
      models: { coPurchase: { hitRateAt3: 0, offerCoverage: 0 } },
    });
  });

  it('reports skipped single-item baskets and counts abstention rather than inflating accuracy', () => {
    const input = dataset();
    input.baskets.push({
      id: 'single',
      createdAt: input.splitAt,
      menuItemIds: ['a'],
    });
    input.availableMenuItemIds = ['a', 'b'];
    expect(evaluateRecommendations(input)).toMatchObject({
      evaluatedBaskets: 1,
      skippedBaskets: 1,
    });
    expect(() =>
      evaluateRecommendations({ ...input, availableMenuItemIds: ['a'] }),
    ).toThrow('EVALUATION_NO_ELIGIBLE_BASKETS');
  });

  it('rejects duplicates, extra private fields, out-of-window records and empty splits', () => {
    const input = dataset();
    expect(
      RecommendationEvaluationSchema.safeParse({
        ...input,
        customerPhone: 'private',
      }).success,
    ).toBe(false);
    expect(
      RecommendationEvaluationSchema.safeParse({
        ...input,
        baskets: [...input.baskets, input.baskets[0]],
      }).success,
    ).toBe(false);
    expect(
      RecommendationEvaluationSchema.safeParse({
        ...input,
        baskets: [{ ...input.baskets[0], menuItemIds: ['a', 'a'] }],
      }).success,
    ).toBe(false);
    expect(
      RecommendationEvaluationSchema.safeParse({
        ...input,
        trainFrom: '2025-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(() =>
      evaluateRecommendations({ ...input, baskets: input.baskets.slice(0, 3) }),
    ).toThrow('EVALUATION_SPLIT_EMPTY');
  });
});
