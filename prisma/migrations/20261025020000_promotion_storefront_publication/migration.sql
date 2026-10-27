-- Existing promotions remain private until a staff member publishes them.
ALTER TABLE "Promotion"
  ADD COLUMN "showOnStorefront" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "storefrontDescription" VARCHAR(500);
