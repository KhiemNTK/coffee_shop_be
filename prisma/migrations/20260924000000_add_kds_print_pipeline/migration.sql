CREATE TYPE "PrintDeviceType" AS ENUM ('RECEIPT', 'KITCHEN');
CREATE TYPE "PrintDeviceStatus" AS ENUM ('READY', 'ERROR', 'PAUSED');
CREATE TYPE "PrintJobType" AS ENUM ('RECEIPT', 'KITCHEN_TICKET');
CREATE TYPE "PrintJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'PRINTED', 'FAILED', 'CANCELLED');

ALTER TABLE "MenuItem"
  ADD COLUMN "kitchenStationId" TEXT;

CREATE TABLE "PrintDevice" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "PrintDeviceType" NOT NULL,
  "paperSize" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "apiKeyHash" TEXT NOT NULL,
  "status" "PrintDeviceStatus" NOT NULL DEFAULT 'READY',
  "lastSeenAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "PrintDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrintDevice_values_check" CHECK (
    length(trim("name")) > 0
    AND length(trim("paperSize")) > 0
    AND length("apiKeyHash") = 64
    AND (NOT "isDefault" OR "type" = 'RECEIPT')
  )
);

CREATE TABLE "KitchenStation" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "prepSlaSeconds" INTEGER NOT NULL DEFAULT 900,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "printDeviceId" TEXT,

  CONSTRAINT "KitchenStation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KitchenStation_values_check" CHECK (
    length(trim("code")) > 0
    AND length(trim("name")) > 0
    AND "prepSlaSeconds" BETWEEN 30 AND 86400
  )
);

CREATE TABLE "KitchenTicket" (
  "id" TEXT NOT NULL,
  "sequence" SERIAL NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stationId" TEXT NOT NULL,
  "orderSessionId" TEXT NOT NULL,

  CONSTRAINT "KitchenTicket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KitchenTicket_dueAt_check" CHECK ("dueAt" >= "createdAt")
);

CREATE TABLE "KitchenTicketItem" (
  "id" TEXT NOT NULL,
  "itemName" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ticketId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,

  CONSTRAINT "KitchenTicketItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KitchenTicketItem_values_check" CHECK (
    length(trim("itemName")) > 0 AND "quantity" > 0
  )
);

CREATE TABLE "PrintJob" (
  "id" TEXT NOT NULL,
  "type" "PrintJobType" NOT NULL,
  "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB NOT NULL,
  "copies" INTEGER NOT NULL DEFAULT 1,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "leaseTokenHash" TEXT,
  "printedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "deduplicationKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deviceId" TEXT,
  "requestedById" TEXT,
  "invoiceId" TEXT,
  "kitchenTicketId" TEXT,
  "reprintOfId" TEXT,

  CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrintJob_values_check" CHECK (
    "copies" BETWEEN 1 AND 10
    AND "attempts" BETWEEN 0 AND "maxAttempts"
    AND "maxAttempts" BETWEEN 1 AND 20
  ),
  CONSTRAINT "PrintJob_source_check" CHECK (
    num_nonnulls("invoiceId", "kitchenTicketId") = 1
    AND (
      ("type" = 'RECEIPT' AND "invoiceId" IS NOT NULL AND "kitchenTicketId" IS NULL)
      OR
      ("type" = 'KITCHEN_TICKET' AND "kitchenTicketId" IS NOT NULL AND "invoiceId" IS NULL)
    )
  ),
  CONSTRAINT "PrintJob_state_check" CHECK (
    (
      "status" = 'PENDING'
      AND "lockedAt" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "leaseTokenHash" IS NULL
      AND "printedAt" IS NULL
      AND "failedAt" IS NULL
    )
    OR (
      "status" = 'PROCESSING'
      AND "deviceId" IS NOT NULL
      AND "lockedAt" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseTokenHash" IS NOT NULL
      AND "printedAt" IS NULL
      AND "failedAt" IS NULL
    )
    OR (
      "status" = 'PRINTED'
      AND "deviceId" IS NOT NULL
      AND "lockedAt" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "leaseTokenHash" IS NULL
      AND "printedAt" IS NOT NULL
      AND "failedAt" IS NULL
    )
    OR (
      "status" = 'FAILED'
      AND "lockedAt" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "leaseTokenHash" IS NULL
      AND "printedAt" IS NULL
      AND "failedAt" IS NOT NULL
    )
    OR (
      "status" = 'CANCELLED'
      AND "lockedAt" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "leaseTokenHash" IS NULL
      AND "printedAt" IS NULL
      AND "failedAt" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "KitchenStation_active_code_upper_unique_idx"
  ON "KitchenStation" (upper("code"))
  WHERE "deletedAt" IS NULL;
CREATE INDEX "KitchenStation_deletedAt_isActive_name_idx"
  ON "KitchenStation" ("deletedAt", "isActive", "name");
CREATE INDEX "KitchenStation_printDeviceId_idx"
  ON "KitchenStation" ("printDeviceId");

CREATE UNIQUE INDEX "KitchenTicket_sequence_key"
  ON "KitchenTicket" ("sequence");
CREATE INDEX "KitchenTicket_stationId_dueAt_createdAt_idx"
  ON "KitchenTicket" ("stationId", "dueAt", "createdAt");
CREATE INDEX "KitchenTicket_orderSessionId_createdAt_idx"
  ON "KitchenTicket" ("orderSessionId", "createdAt");

CREATE UNIQUE INDEX "KitchenTicketItem_orderItemId_key"
  ON "KitchenTicketItem" ("orderItemId");
CREATE INDEX "KitchenTicketItem_ticketId_createdAt_idx"
  ON "KitchenTicketItem" ("ticketId", "createdAt");

CREATE UNIQUE INDEX "PrintDevice_active_name_upper_unique_idx"
  ON "PrintDevice" (upper("name"))
  WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "PrintDevice_active_default_type_unique_idx"
  ON "PrintDevice" ("type")
  WHERE "deletedAt" IS NULL AND "isActive" = true AND "isDefault" = true;
CREATE UNIQUE INDEX "PrintDevice_apiKeyHash_key"
  ON "PrintDevice" ("apiKeyHash");
CREATE INDEX "PrintDevice_deletedAt_type_isActive_idx"
  ON "PrintDevice" ("deletedAt", "type", "isActive");
CREATE INDEX "PrintDevice_status_lastSeenAt_idx"
  ON "PrintDevice" ("status", "lastSeenAt");

CREATE UNIQUE INDEX "PrintJob_deduplicationKey_key"
  ON "PrintJob" ("deduplicationKey");
CREATE INDEX "PrintJob_deviceId_status_availableAt_createdAt_idx"
  ON "PrintJob" ("deviceId", "status", "availableAt", "createdAt");
CREATE INDEX "PrintJob_invoiceId_createdAt_idx"
  ON "PrintJob" ("invoiceId", "createdAt");
CREATE INDEX "PrintJob_kitchenTicketId_idx"
  ON "PrintJob" ("kitchenTicketId");
CREATE INDEX "PrintJob_requestedById_createdAt_idx"
  ON "PrintJob" ("requestedById", "createdAt");
CREATE INDEX "PrintJob_leaseExpiresAt_idx"
  ON "PrintJob" ("leaseExpiresAt");

ALTER TABLE "MenuItem"
  ADD CONSTRAINT "MenuItem_kitchenStationId_fkey"
    FOREIGN KEY ("kitchenStationId") REFERENCES "KitchenStation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KitchenStation"
  ADD CONSTRAINT "KitchenStation_printDeviceId_fkey"
    FOREIGN KEY ("printDeviceId") REFERENCES "PrintDevice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KitchenTicket"
  ADD CONSTRAINT "KitchenTicket_stationId_fkey"
    FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "KitchenTicket_orderSessionId_fkey"
    FOREIGN KEY ("orderSessionId") REFERENCES "OrderSession"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "KitchenTicketItem"
  ADD CONSTRAINT "KitchenTicketItem_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "KitchenTicket"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KitchenTicketItem_orderItemId_fkey"
    FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrintJob"
  ADD CONSTRAINT "PrintJob_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "PrintDevice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "PrintJob_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PrintJob_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PrintJob_kitchenTicketId_fkey"
    FOREIGN KEY ("kitchenTicketId") REFERENCES "KitchenTicket"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PrintJob_reprintOfId_fkey"
    FOREIGN KEY ("reprintOfId") REFERENCES "PrintJob"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
