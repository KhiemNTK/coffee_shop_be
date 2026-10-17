CREATE TYPE "MenuImageStatus" AS ENUM ('UPLOADING', 'READY', 'ATTACHED', 'DELETING');

CREATE TABLE "MenuImageUpload" (
    "id" TEXT NOT NULL,
    "objectKey" VARCHAR(255) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "status" "MenuImageStatus" NOT NULL DEFAULT 'UPLOADING',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "employeeId" TEXT NOT NULL,
    "menuItemId" TEXT,
    CONSTRAINT "MenuImageUpload_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MenuImageUpload_state_check" CHECK (
      ("status" = 'ATTACHED' AND "menuItemId" IS NOT NULL AND "expiresAt" IS NULL) OR
      ("status" IN ('UPLOADING', 'READY', 'DELETING') AND "expiresAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "MenuImageUpload_objectKey_key" ON "MenuImageUpload"("objectKey");
CREATE UNIQUE INDEX "MenuImageUpload_url_key" ON "MenuImageUpload"("url");
CREATE INDEX "MenuImageUpload_status_expiresAt_idx" ON "MenuImageUpload"("status", "expiresAt");
CREATE INDEX "MenuImageUpload_menuItemId_status_idx" ON "MenuImageUpload"("menuItemId", "status");
CREATE INDEX "MenuImageUpload_employeeId_createdAt_idx" ON "MenuImageUpload"("employeeId", "createdAt");
ALTER TABLE "MenuImageUpload" ADD CONSTRAINT "MenuImageUpload_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MenuImageUpload" ADD CONSTRAINT "MenuImageUpload_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
