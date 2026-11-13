CREATE TYPE "VoucherCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');
CREATE TYPE "CustomerVoucherSource" AS ENUM ('CLAIM', 'GIFT');
CREATE TYPE "VoucherRedemptionStatus" AS ENUM ('RESERVED', 'REDEEMED', 'RELEASED');

CREATE TABLE "VoucherCampaign" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "isPublic" BOOLEAN NOT NULL DEFAULT false,
  "status" "VoucherCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "discountType" "DiscountType" NOT NULL,
  "discountValue" DECIMAL(18,2) NOT NULL,
  "maxDiscount" DECIMAL(18,2),
  "minSubtotal" DECIMAL(18,2) NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "issuanceLimit" INTEGER NOT NULL,
  "issuedCount" INTEGER NOT NULL DEFAULT 0,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VoucherCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoucherCampaign_counts_check" CHECK ("issuanceLimit" > 0 AND "issuedCount" >= 0 AND "issuedCount" <= "issuanceLimit"),
  CONSTRAINT "VoucherCampaign_terms_check" CHECK (
    "endDate" > "startDate" AND "discountValue" > 0 AND "minSubtotal" > 0
    AND ("maxDiscount" IS NULL OR "maxDiscount" > 0)
    AND (("discountType" = 'PERCENTAGE' AND "discountValue" < 100 AND "maxDiscount" IS NOT NULL)
      OR ("discountType" = 'FIXED_AMOUNT' AND "minSubtotal" > "discountValue"))
  ),
  CONSTRAINT "VoucherCampaign_publication_check" CHECK (("status" = 'DRAFT') = ("publishedAt" IS NULL))
);

CREATE TABLE "CustomerVoucher" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "source" "CustomerVoucherSource" NOT NULL,
  "sourceKey" VARCHAR(80) NOT NULL,
  "sourceOrderId" TEXT,
  "issuedById" TEXT,
  "reason" VARCHAR(500),
  "revokedAt" TIMESTAMP(3),
  "revokedById" TEXT,
  "revocationReason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerVoucher_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerVoucher_source_check" CHECK (
    ("source" = 'CLAIM' AND "sourceKey" = 'CLAIM:' || "customerId" AND "sourceOrderId" IS NULL AND "issuedById" IS NULL)
    OR ("source" = 'GIFT' AND "sourceKey" = 'GIFT:' || "sourceOrderId" AND "sourceOrderId" IS NOT NULL AND "issuedById" IS NOT NULL AND "reason" IS NOT NULL AND length(trim("reason")) >= 2)
  ),
  CONSTRAINT "CustomerVoucher_revocation_check" CHECK (
    ("revokedAt" IS NULL AND "revokedById" IS NULL AND "revocationReason" IS NULL)
    OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revocationReason" IS NOT NULL AND length(trim("revocationReason")) >= 2)
  )
);

CREATE TABLE "VoucherRedemption" (
  "id" TEXT NOT NULL,
  "customerVoucherId" TEXT NOT NULL,
  "onlineOrderRequestId" TEXT NOT NULL,
  "invoiceId" TEXT,
  "status" "VoucherRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
  "subTotal" DECIMAL(18,2) NOT NULL,
  "discountAmount" DECIMAL(18,2) NOT NULL,
  "totalAmount" DECIMAL(18,2) NOT NULL,
  "discountSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "redeemedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "releaseReason" VARCHAR(100),
  CONSTRAINT "VoucherRedemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoucherRedemption_amounts_check" CHECK ("subTotal" > 0 AND "discountAmount" > 0 AND "totalAmount" > 0 AND "totalAmount" = "subTotal" - "discountAmount"),
  CONSTRAINT "VoucherRedemption_state_check" CHECK (
    ("status" = 'RESERVED' AND "invoiceId" IS NULL AND "redeemedAt" IS NULL AND "releasedAt" IS NULL)
    OR ("status" = 'REDEEMED' AND "invoiceId" IS NOT NULL AND "redeemedAt" IS NOT NULL AND "releasedAt" IS NULL)
    OR ("status" = 'RELEASED' AND "invoiceId" IS NULL AND "redeemedAt" IS NULL AND "releasedAt" IS NOT NULL AND "releaseReason" IS NOT NULL)
  )
);

ALTER TABLE "OnlineOrderRequest" ADD COLUMN "discountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "OnlineOrderRequest" ADD COLUMN "quotedTotal" DECIMAL(18,2);
UPDATE "OnlineOrderRequest" SET "quotedTotal" = "quotedSubtotal";
ALTER TABLE "OnlineOrderRequest" ALTER COLUMN "quotedTotal" SET NOT NULL;
ALTER TABLE "OnlineOrderRequest" ADD CONSTRAINT "OnlineOrderRequest_discount_check"
  CHECK ("discountAmount" >= 0 AND "quotedTotal" >= 0 AND "quotedTotal" = "quotedSubtotal" - "discountAmount");

CREATE INDEX "VoucherCampaign_status_isPublic_startDate_endDate_idx" ON "VoucherCampaign"("status", "isPublic", "startDate", "endDate");
CREATE INDEX "VoucherCampaign_createdAt_id_idx" ON "VoucherCampaign"("createdAt", "id");
CREATE UNIQUE INDEX "CustomerVoucher_campaignId_sourceKey_key" ON "CustomerVoucher"("campaignId", "sourceKey");
CREATE INDEX "CustomerVoucher_customerId_createdAt_id_idx" ON "CustomerVoucher"("customerId", "createdAt", "id");
CREATE INDEX "CustomerVoucher_sourceOrderId_idx" ON "CustomerVoucher"("sourceOrderId");
CREATE INDEX "CustomerVoucher_issuedById_idx" ON "CustomerVoucher"("issuedById");
CREATE INDEX "CustomerVoucher_revokedById_idx" ON "CustomerVoucher"("revokedById");
CREATE UNIQUE INDEX "VoucherRedemption_onlineOrderRequestId_key" ON "VoucherRedemption"("onlineOrderRequestId");
CREATE UNIQUE INDEX "VoucherRedemption_invoiceId_key" ON "VoucherRedemption"("invoiceId");
CREATE UNIQUE INDEX "VoucherRedemption_one_live_grant" ON "VoucherRedemption"("customerVoucherId") WHERE "status" IN ('RESERVED', 'REDEEMED');
CREATE INDEX "VoucherRedemption_customerVoucherId_createdAt_idx" ON "VoucherRedemption"("customerVoucherId", "createdAt");
CREATE INDEX "VoucherRedemption_status_createdAt_idx" ON "VoucherRedemption"("status", "createdAt");

ALTER TABLE "CustomerVoucher" ADD CONSTRAINT "CustomerVoucher_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "VoucherCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerVoucher" ADD CONSTRAINT "CustomerVoucher_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerVoucher" ADD CONSTRAINT "CustomerVoucher_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "OnlineOrderRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerVoucher" ADD CONSTRAINT "CustomerVoucher_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerVoucher" ADD CONSTRAINT "CustomerVoucher_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_customerVoucherId_fkey" FOREIGN KEY ("customerVoucherId") REFERENCES "CustomerVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_onlineOrderRequestId_fkey" FOREIGN KEY ("onlineOrderRequestId") REFERENCES "OnlineOrderRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
