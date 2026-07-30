-- Orders production hardening indexes.
CREATE INDEX IF NOT EXISTS "OrderSession_sessionStatus_createdAt_idx"
ON "OrderSession" ("sessionStatus", "createdAt");

CREATE INDEX IF NOT EXISTS "OrderSession_tableId_sessionStatus_idx"
ON "OrderSession" ("tableId", "sessionStatus");

CREATE INDEX IF NOT EXISTS "OrderSession_employeeId_idx"
ON "OrderSession" ("employeeId");

CREATE INDEX IF NOT EXISTS "OrderSession_shiftId_idx"
ON "OrderSession" ("shiftId");

CREATE INDEX IF NOT EXISTS "OrderItem_orderSessionId_idx"
ON "OrderItem" ("orderSessionId");

CREATE INDEX IF NOT EXISTS "OrderItem_menuItemId_idx"
ON "OrderItem" ("menuItemId");

CREATE INDEX IF NOT EXISTS "OrderItem_invoiceId_idx"
ON "OrderItem" ("invoiceId");

CREATE INDEX IF NOT EXISTS "OrderItem_serveStatus_idx"
ON "OrderItem" ("serveStatus");

CREATE INDEX IF NOT EXISTS "OrderItem_isPaid_idx"
ON "OrderItem" ("isPaid");

CREATE UNIQUE INDEX IF NOT EXISTS "order_session_one_active_per_table"
ON "OrderSession" ("tableId")
WHERE "tableId" IS NOT NULL
  AND "sessionStatus" = 'ACTIVE';
