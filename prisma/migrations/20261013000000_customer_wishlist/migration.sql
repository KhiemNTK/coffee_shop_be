CREATE TABLE "Customer" (
  "id" TEXT NOT NULL,
  "googleSubject" VARCHAR(255) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Customer_googleSubject_key" ON "Customer"("googleSubject");

CREATE TABLE "CustomerSession" (
  "id" TEXT NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "customerId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerSession_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustomerSession_tokenHash_key" ON "CustomerSession"("tokenHash");
CREATE INDEX "CustomerSession_customerId_createdAt_idx" ON "CustomerSession"("customerId", "createdAt");
CREATE INDEX "CustomerSession_expiresAt_idx" ON "CustomerSession"("expiresAt");

CREATE TABLE "CustomerWishlist" (
  "customerId" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerWishlist_pkey" PRIMARY KEY ("customerId", "menuItemId"),
  CONSTRAINT "CustomerWishlist_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CustomerWishlist_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CustomerWishlist_menuItemId_idx" ON "CustomerWishlist"("menuItemId");
