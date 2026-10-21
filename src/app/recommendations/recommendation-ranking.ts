export function rankRecommendationCandidates(
  pairs: ReadonlyArray<{ candidateId: string; support: number }>,
): string[] {
  const scores = new Map<string, number>();
  for (const pair of pairs) {
    scores.set(
      pair.candidateId,
      (scores.get(pair.candidateId) ?? 0) + pair.support,
    );
  }
  return [...scores]
    .sort(([a, scoreA], [b, scoreB]) => scoreB - scoreA || a.localeCompare(b))
    .map(([id]) => id);
}
