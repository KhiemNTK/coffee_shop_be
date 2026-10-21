-- Existing resolution notes stay private; historical replies are intentionally null.
ALTER TABLE "TakeawayFeedback" ADD COLUMN "customerReply" VARCHAR(500);
