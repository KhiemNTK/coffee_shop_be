CREATE TYPE "BusinessInsightStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "BusinessInsight" (
  "id" VARCHAR(64) NOT NULL,
  "employeeId" TEXT NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "from" TIMESTAMP(3) NOT NULL,
  "to" TIMESTAMP(3) NOT NULL,
  "timeZone" VARCHAR(64) NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "model" VARCHAR(128) NOT NULL,
  "promptVersion" VARCHAR(64) NOT NULL,
  "status" "BusinessInsightStatus" NOT NULL DEFAULT 'QUEUED',
  "snapshot" JSONB,
  "analysis" JSONB,
  "errorCode" VARCHAR(64),
  "providerStartedAt" TIMESTAMP(3),
  CONSTRAINT "BusinessInsight_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BusinessInsight_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BusinessInsight_period_check" CHECK ("from" < "to" AND "expiresAt" > "requestedAt"),
  CONSTRAINT "BusinessInsight_completed_check" CHECK ("status" <> 'COMPLETED' OR ("snapshot" IS NOT NULL AND "analysis" IS NOT NULL))
);

CREATE INDEX "BusinessInsight_employeeId_requestedAt_id_idx" ON "BusinessInsight"("employeeId", "requestedAt" DESC, "id" DESC);
CREATE INDEX "BusinessInsight_expiresAt_idx" ON "BusinessInsight"("expiresAt");
