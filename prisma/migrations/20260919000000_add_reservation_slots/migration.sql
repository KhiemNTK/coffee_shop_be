CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Reservation"
  ADD COLUMN "startsAt" TIMESTAMP(3),
  ADD COLUMN "endsAt" TIMESTAMP(3),
  ADD COLUMN "guestCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "checkedInAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancellationReason" TEXT,
  ADD COLUMN "noShowAt" TIMESTAMP(3),
  ADD COLUMN "orderSessionId" TEXT;

UPDATE "Reservation"
SET "startsAt" = "reservationDate"::date + "reservationTime"::time;

UPDATE "Reservation"
SET "endsAt" = "startsAt" + INTERVAL '90 minutes';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Reservation" current_reservation
    JOIN "Reservation" conflicting_reservation
      ON current_reservation."id" < conflicting_reservation."id"
      AND current_reservation."tableId" = conflicting_reservation."tableId"
      AND tsrange(
        current_reservation."startsAt",
        current_reservation."endsAt",
        '[)'
      ) && tsrange(
        conflicting_reservation."startsAt",
        conflicting_reservation."endsAt",
        '[)'
      )
    WHERE current_reservation."status" IN ('PENDING', 'ARRIVED')
      AND conflicting_reservation."status" IN ('PENDING', 'ARRIVED')
  ) THEN
    RAISE EXCEPTION 'Overlapping active reservations must be resolved before migration.';
  END IF;
END $$;

ALTER TABLE "Reservation"
  ALTER COLUMN "startsAt" SET NOT NULL,
  ALTER COLUMN "endsAt" SET NOT NULL,
  DROP COLUMN "reservationDate",
  DROP COLUMN "reservationTime";

CREATE UNIQUE INDEX "Reservation_orderSessionId_key"
  ON "Reservation"("orderSessionId");

CREATE INDEX "Reservation_status_startsAt_idx"
  ON "Reservation"("status", "startsAt");

CREATE INDEX "Reservation_tableId_startsAt_idx"
  ON "Reservation"("tableId", "startsAt");

CREATE INDEX "Reservation_phoneNumber_idx"
  ON "Reservation"("phoneNumber");

ALTER TABLE "Reservation"
  ADD CONSTRAINT "Reservation_valid_time_range_check"
    CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "Reservation_positive_guest_count_check"
    CHECK ("guestCount" > 0),
  ADD CONSTRAINT "Reservation_orderSessionId_fkey"
    FOREIGN KEY ("orderSessionId") REFERENCES "OrderSession"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Reservation_no_overlapping_active_slots"
    EXCLUDE USING gist (
      "tableId" WITH =,
      tsrange("startsAt", "endsAt", '[)') WITH &&
    ) WHERE ("status" IN ('PENDING', 'ARRIVED'));
