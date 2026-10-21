import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { rankRecommendationCandidates } from '../app/recommendations/recommendation-ranking';
import {
  RECOMMENDATION_LIMIT,
  RECOMMENDATION_MIN_SUPPORT,
  RECOMMENDATION_PAIRS_PER_ANCHOR,
} from '../common/consts/recommendations';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const uniqueIds = z
  .array(id)
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate item IDs');
export const RecommendationEvaluationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    trainFrom: z.iso.datetime({ offset: true }),
    splitAt: z.iso.datetime({ offset: true }),
    testTo: z.iso.datetime({ offset: true }),
    availableMenuItemIds: uniqueIds,
    baskets: z
      .array(
        z.strictObject({
          id,
          createdAt: z.iso.datetime({ offset: true }),
          menuItemIds: uniqueIds.max(10),
        }),
      )
      .min(2)
      .max(10_000),
  })
  .superRefine((data, context) => {
    const start = Date.parse(data.trainFrom);
    const split = Date.parse(data.splitAt);
    const end = Date.parse(data.testTo);
    if (
      !(start < split && split < end) ||
      split - start > 90 * 86_400_000 ||
      end - split > 31 * 86_400_000
    )
      context.addIssue({
        code: 'custom',
        message: 'Use up to 90 training days followed by up to 31 test days',
      });
    if (
      new Set(data.baskets.map((basket) => basket.id)).size !==
      data.baskets.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate basket IDs' });
    if (
      data.baskets.some(
        (basket) =>
          Date.parse(basket.createdAt) < start ||
          Date.parse(basket.createdAt) >= end,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Basket outside evaluation window',
      });
  });

export function evaluateRecommendations(input: unknown) {
  const data = RecommendationEvaluationSchema.parse(input);
  const split = Date.parse(data.splitAt);
  const train = data.baskets.filter(
    (basket) => Date.parse(basket.createdAt) < split,
  );
  const test = data.baskets.filter(
    (basket) => Date.parse(basket.createdAt) >= split,
  );
  if (!train.length || !test.length) throw new Error('EVALUATION_SPLIT_EMPTY');
  const available = new Set(data.availableMenuItemIds);
  const popularity = new Map<string, number>();
  const supports = new Map<string, Map<string, number>>();
  for (const basket of train) {
    for (const anchor of basket.menuItemIds) {
      popularity.set(anchor, (popularity.get(anchor) ?? 0) + 1);
      const candidates = supports.get(anchor) ?? new Map<string, number>();
      for (const candidate of basket.menuItemIds) {
        if (candidate !== anchor)
          candidates.set(candidate, (candidates.get(candidate) ?? 0) + 1);
      }
      supports.set(anchor, candidates);
    }
  }
  const pairs = new Map(
    [...supports].map(([anchor, candidates]) => [
      anchor,
      [...candidates]
        .filter(([, support]) => support >= RECOMMENDATION_MIN_SUPPORT)
        .sort(([a, sa], [b, sb]) => sb - sa || a.localeCompare(b))
        .slice(0, RECOMMENDATION_PAIRS_PER_ANCHOR)
        .map(([candidateId, support]) => ({ candidateId, support })),
    ]),
  );
  const popularIds = rankRecommendationCandidates(
    [...popularity].map(([candidateId, support]) => ({ candidateId, support })),
  );
  const scores = {
    coPurchase: { hits: 0, reciprocalRank: 0, offered: 0, suggestions: 0 },
    popular: { hits: 0, reciprocalRank: 0, offered: 0, suggestions: 0 },
  };
  let evaluated = 0;
  let coldTargets = 0;
  let noSupportedAnchors = 0;
  for (const basket of test) {
    const items = basket.menuItemIds
      .filter((item) => available.has(item))
      .sort();
    if (items.length < 2) continue;
    // Hide one reproducible target; the full test basket never enters training.
    const index =
      createHash('sha256').update(basket.id).digest().readUInt32BE(0) %
      items.length;
    const target = items[index];
    const anchors = new Set(items.filter((item) => item !== target));
    const candidates = [...anchors]
      .flatMap((anchor) => pairs.get(anchor) ?? [])
      .filter((pair) => !anchors.has(pair.candidateId));
    const predicted = rankRecommendationCandidates(candidates);
    if (!popularity.has(target)) coldTargets++;
    if (!candidates.length) noSupportedAnchors++;
    for (const [name, ranked] of [
      ['coPurchase', predicted],
      ['popular', popularIds],
    ] as const) {
      const suggestions = ranked
        .filter((item) => available.has(item) && !anchors.has(item))
        .slice(0, RECOMMENDATION_LIMIT);
      const rank = suggestions.indexOf(target);
      const score = scores[name];
      score.hits += rank >= 0 ? 1 : 0;
      score.reciprocalRank += rank >= 0 ? 1 / (rank + 1) : 0;
      score.offered += suggestions.length > 0 ? 1 : 0;
      score.suggestions += suggestions.length;
    }
    evaluated++;
  }
  if (!evaluated) throw new Error('EVALUATION_NO_ELIGIBLE_BASKETS');
  return {
    schemaVersion: 1,
    k: RECOMMENDATION_LIMIT,
    period: {
      trainFrom: data.trainFrom,
      splitAt: data.splitAt,
      testTo: data.testTo,
    },
    trainingBaskets: train.length,
    testBaskets: test.length,
    evaluatedBaskets: evaluated,
    skippedBaskets: test.length - evaluated,
    coldTargets,
    noSupportedAnchors,
    models: Object.fromEntries(
      Object.entries(scores).map(([name, score]) => [
        name,
        {
          hitRateAt3: score.hits / evaluated,
          meanReciprocalRankAt3: score.reciprocalRank / evaluated,
          offerCoverage: score.offered / evaluated,
          averageSuggestionCount: score.suggestions / evaluated,
        },
      ]),
    ),
    conclusion: 'DESCRIPTIVE_ONLY_NOT_CAUSAL',
  };
}

export async function readRecommendationDataset(path: string) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
      throw new Error('EVALUATION_FILE_TOO_LARGE');
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 5 * 1024 * 1024) throw new Error('EVALUATION_FILE_TOO_LARGE');
    return JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown;
  } finally {
    await file.close();
  }
}

if (require.main === module) {
  void (async () => {
    const { values } = parseArgs({ options: { input: { type: 'string' } } });
    if (!values.input) throw new Error('EVALUATION_INPUT_REQUIRED');
    console.log(
      JSON.stringify(
        evaluateRecommendations(await readRecommendationDataset(values.input)),
        null,
        2,
      ),
    );
  })().catch(() => {
    console.error(
      'EVALUATION_FAILED: provide a valid, bounded dataset with --input. No database was changed.',
    );
    process.exitCode = 1;
  });
}
