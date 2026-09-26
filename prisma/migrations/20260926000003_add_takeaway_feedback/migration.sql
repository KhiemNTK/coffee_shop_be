CREATE TABLE "TakeawayFeedback" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "comment" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TakeawayFeedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TakeawayFeedback_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX "TakeawayFeedback_invoiceId_key"
  ON "TakeawayFeedback"("invoiceId");
CREATE INDEX "TakeawayFeedback_createdAt_id_idx"
  ON "TakeawayFeedback"("createdAt", "id");
CREATE INDEX "TakeawayFeedback_rating_createdAt_id_idx"
  ON "TakeawayFeedback"("rating", "createdAt", "id");

ALTER TABLE "TakeawayFeedback"
  ADD CONSTRAINT "TakeawayFeedback_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
