ALTER TABLE "OnlineOrderRequest"
  ADD COLUMN "telegramChatId" VARCHAR(32),
  ADD COLUMN "telegramLinkTokenHash" VARCHAR(64),
  ADD COLUMN "telegramLinkExpiresAt" TIMESTAMP(3),
  ADD COLUMN "telegramReadyNotifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "OnlineOrderRequest_telegramLinkTokenHash_key"
  ON "OnlineOrderRequest"("telegramLinkTokenHash");
