CREATE TYPE "ReservationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

CREATE TABLE "ReservationRequest" (
  "id" TEXT NOT NULL,
  "customerName" TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "guestCount" INTEGER NOT NULL,
  "notes" TEXT,
  "status" "ReservationRequestStatus" NOT NULL DEFAULT 'PENDING',
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "reservationId" INTEGER,
  CONSTRAINT "ReservationRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReservationRequest_valid_window_check" CHECK ("endsAt" > "startsAt"),
  CONSTRAINT "ReservationRequest_guest_count_check" CHECK ("guestCount" > 0)
);

CREATE UNIQUE INDEX "ReservationRequest_reservationId_key" ON "ReservationRequest"("reservationId");
CREATE INDEX "ReservationRequest_status_startsAt_createdAt_idx" ON "ReservationRequest"("status", "startsAt", "createdAt");
CREATE INDEX "ReservationRequest_phoneNumber_createdAt_idx" ON "ReservationRequest"("phoneNumber", "createdAt");

ALTER TABLE "ReservationRequest"
  ADD CONSTRAINT "ReservationRequest_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReservationRequest_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
