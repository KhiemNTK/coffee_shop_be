CREATE INDEX IF NOT EXISTS "Invoice_orderSessionId_idx"
ON "Invoice" ("orderSessionId");

CREATE INDEX IF NOT EXISTS "Invoice_employeeId_idx"
ON "Invoice" ("employeeId");

CREATE INDEX IF NOT EXISTS "Invoice_shiftId_idx"
ON "Invoice" ("shiftId");

CREATE INDEX IF NOT EXISTS "Invoice_paymentStatus_createdAt_idx"
ON "Invoice" ("paymentStatus", "createdAt");

CREATE INDEX IF NOT EXISTS "Invoice_createdAt_idx"
ON "Invoice" ("createdAt");
