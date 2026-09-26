ALTER TYPE "ReservationRequestStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "ReservationRequest"
  ADD COLUMN "accessTokenHash" VARCHAR(64),
  ADD COLUMN "cancelledAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "ReservationRequest_accessTokenHash_key"
  ON "ReservationRequest"("accessTokenHash");
