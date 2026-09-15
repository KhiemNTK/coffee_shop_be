-- Authentication session hardening.
-- This migration is intentionally created but must be applied through the
-- deployment pipeline after backup and migration preflight.

CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key"
    ON "AuthSession"("refreshTokenHash");
CREATE INDEX "AuthSession_employeeId_revokedAt_idx"
    ON "AuthSession"("employeeId", "revokedAt");
CREATE INDEX "AuthSession_familyId_revokedAt_idx"
    ON "AuthSession"("familyId", "revokedAt");
CREATE INDEX "AuthSession_expiresAt_idx"
    ON "AuthSession"("expiresAt");

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key"
    ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_employeeId_usedAt_idx"
    ON "PasswordResetToken"("employeeId", "usedAt");
CREATE INDEX "PasswordResetToken_expiresAt_idx"
    ON "PasswordResetToken"("expiresAt");

ALTER TABLE "AuthSession"
    ADD CONSTRAINT "AuthSession_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PasswordResetToken"
    ADD CONSTRAINT "PasswordResetToken_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
