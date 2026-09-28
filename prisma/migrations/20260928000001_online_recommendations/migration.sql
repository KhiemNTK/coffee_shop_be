CREATE TABLE "MenuItemRecommendationPair" (
  "anchorId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "support" INTEGER NOT NULL,
  "refreshedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MenuItemRecommendationPair_pkey" PRIMARY KEY ("anchorId", "candidateId"),
  CONSTRAINT "MenuItemRecommendationPair_anchorId_fkey" FOREIGN KEY ("anchorId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MenuItemRecommendationPair_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MenuItemRecommendationPair_distinct_check" CHECK ("anchorId" <> "candidateId"),
  CONSTRAINT "MenuItemRecommendationPair_support_check" CHECK ("support" > 0)
);

CREATE INDEX "MenuItemRecommendationPair_candidateId_idx" ON "MenuItemRecommendationPair"("candidateId");
CREATE INDEX "MenuItemRecommendationPair_refreshedAt_idx" ON "MenuItemRecommendationPair"("refreshedAt");

CREATE TABLE "RecommendationExposure" (
  "id" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "basketHash" VARCHAR(64) NOT NULL,
  "variant" VARCHAR(16) NOT NULL,
  "candidateIds" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecommendationExposure_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecommendationExposure_variant_check" CHECK ("variant" IN ('CONTROL', 'TREATMENT'))
);

CREATE UNIQUE INDEX "RecommendationExposure_clientRequestId_key" ON "RecommendationExposure"("clientRequestId");
CREATE INDEX "RecommendationExposure_createdAt_idx" ON "RecommendationExposure"("createdAt");
