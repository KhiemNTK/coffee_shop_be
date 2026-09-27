ALTER TABLE "TakeawayFeedback"
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolutionNote" VARCHAR(500),
  ADD COLUMN "resolvedById" TEXT;

ALTER TABLE "TakeawayFeedback"
  ADD CONSTRAINT "TakeawayFeedback_resolution_check" CHECK (
    ("resolvedAt" IS NULL AND "resolutionNote" IS NULL AND "resolvedById" IS NULL)
    OR (
      "rating" <= 2
      AND "resolvedAt" IS NOT NULL
      AND "resolvedById" IS NOT NULL
      AND "resolutionNote" IS NOT NULL
      AND length(btrim("resolutionNote")) > 0
    )
  );

ALTER TABLE "TakeawayFeedback"
  ADD CONSTRAINT "TakeawayFeedback_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "Employee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "TakeawayFeedback_resolvedById_idx"
  ON "TakeawayFeedback"("resolvedById");
CREATE INDEX "TakeawayFeedback_open_cases_idx"
  ON "TakeawayFeedback"("createdAt", "id")
  WHERE "rating" <= 2 AND "resolvedAt" IS NULL;
