CREATE TYPE "OnlineOrderStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

CREATE TABLE "OnlineOrderRequest" (
  "id" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "pickupName" VARCHAR(80) NOT NULL,
  "phoneNumber" VARCHAR(20) NOT NULL,
  "quotedSubtotal" DECIMAL(18,2) NOT NULL,
  "status" "OnlineOrderStatus" NOT NULL DEFAULT 'PENDING',
  "rejectionReason" VARCHAR(200),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "reviewedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "orderSessionId" TEXT,
  CONSTRAINT "OnlineOrderRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OnlineOrderRequest_requestHash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "OnlineOrderRequest_pickupName_check" CHECK (LENGTH(BTRIM("pickupName")) >= 2),
  CONSTRAINT "OnlineOrderRequest_quote_check" CHECK ("quotedSubtotal" >= 0 AND "expiresAt" > "createdAt"),
  CONSTRAINT "OnlineOrderRequest_state_check" CHECK (
    ("status" = 'PENDING' AND "reviewedAt" IS NULL AND "reviewedById" IS NULL AND "orderSessionId" IS NULL AND "rejectionReason" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'ACCEPTED' AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL AND "orderSessionId" IS NOT NULL AND "rejectionReason" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'REJECTED' AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL AND "orderSessionId" IS NULL AND "rejectionReason" IS NOT NULL AND LENGTH(BTRIM("rejectionReason")) >= 2 AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "reviewedAt" IS NULL AND "reviewedById" IS NULL AND "orderSessionId" IS NULL AND "rejectionReason" IS NULL)
  )
);

CREATE TABLE "OnlineOrderRequestItem" (
  "id" TEXT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "note" VARCHAR(255),
  "quotedName" TEXT NOT NULL,
  "quotedUnitPrice" DECIMAL(18,2) NOT NULL,
  "onlineOrderRequestId" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  CONSTRAINT "OnlineOrderRequestItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OnlineOrderRequestItem_lineNumber_check" CHECK ("lineNumber" BETWEEN 1 AND 20),
  CONSTRAINT "OnlineOrderRequestItem_quantity_check" CHECK ("quantity" BETWEEN 1 AND 20),
  CONSTRAINT "OnlineOrderRequestItem_price_check" CHECK ("quotedUnitPrice" >= 0)
);

CREATE UNIQUE INDEX "OnlineOrderRequest_clientRequestId_key" ON "OnlineOrderRequest"("clientRequestId");
CREATE UNIQUE INDEX "OnlineOrderRequest_orderSessionId_key" ON "OnlineOrderRequest"("orderSessionId");
CREATE INDEX "OnlineOrderRequest_status_expiresAt_id_idx" ON "OnlineOrderRequest"("status", "expiresAt", "id");
CREATE INDEX "OnlineOrderRequest_createdAt_idx" ON "OnlineOrderRequest"("createdAt");
CREATE INDEX "OnlineOrderRequest_reviewedById_idx" ON "OnlineOrderRequest"("reviewedById");
CREATE UNIQUE INDEX "OnlineOrderRequestItem_onlineOrderRequestId_lineNumber_key" ON "OnlineOrderRequestItem"("onlineOrderRequestId", "lineNumber");
CREATE INDEX "OnlineOrderRequestItem_menuItemId_idx" ON "OnlineOrderRequestItem"("menuItemId");

ALTER TABLE "OnlineOrderRequest"
  ADD CONSTRAINT "OnlineOrderRequest_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OnlineOrderRequest"
  ADD CONSTRAINT "OnlineOrderRequest_orderSessionId_fkey"
  FOREIGN KEY ("orderSessionId") REFERENCES "OrderSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OnlineOrderRequestItem"
  ADD CONSTRAINT "OnlineOrderRequestItem_onlineOrderRequestId_fkey"
  FOREIGN KEY ("onlineOrderRequestId") REFERENCES "OnlineOrderRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OnlineOrderRequestItem"
  ADD CONSTRAINT "OnlineOrderRequestItem_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
