# Telegram notifications

Optional notifications reuse the order outbox. There is no Telegram call inside an order transaction or the public order submission request. Telegram is not the source of truth for order, preparation, payment or handoff state.

## Configuration

All credentials stay on the backend. Never add bot tokens to a frontend `VITE_*` variable.

```dotenv
TELEGRAM_BOT_TOKEN=<BotFather token>
# Customer subscriptions also require both values below:
TELEGRAM_BOT_USERNAME=<bot username without @>
TELEGRAM_WEBHOOK_SECRET=<random 32+ character secret>
# Optional staff group; omit to disable new-order staff alerts:
TELEGRAM_STAFF_CHAT_ID=-1001234567890
# Optional frontend HTTPS origin, with no path, query or credentials:
TELEGRAM_WEB_APP_URL=https://your-coffee-domain.example
```

For staff-only alerts, configure just the bot token and staff chat ID. No incoming webhook is needed. Add the bot to a private staff group with permission to send messages. Keep bot privacy mode enabled; group commands are ignored by the application. If Telegram migrates the group to a supergroup, update the configured chat ID and restart the application; do not auto-trust a different destination from an error response.

For customer subscriptions, register `POST /api/v1/online-orders/telegram/webhook` with Telegram `setWebhook`, using the configured secret as `secret_token` and `allowed_updates: ["message"]`. Use the actual configured API prefix and a public HTTPS backend URL. Never paste the bot token or webhook secret into logs or a support conversation.

## Delivery and privacy

- The one-time customer subscription link is created only by an explicit click. `/start` links a private chat; `/stop` removes that chat's subscriptions.
- Customer messages use Vietnamese and real current state. Ready messages state payment is due at collection; they do not claim that an online payment was received.
- A signed-in customer's button opens `/account/orders/:id`, protected by normal customer authentication and ownership checks. A guest's button opens `/order?view=lookup`; the guest must still supply the existing order ID and access code. Neither URL contains an order access, cancellation, pickup or reorder token.
- Staff alerts are inserted in the same transaction as a newly created request. Retrying the same client request does not insert another alert. The message contains a short order reference, up to five item summaries, pickup time in the shop's timezone and an estimated subtotal. It contains no customer name, phone number, free-text order note or access credential. The staff button opens the existing authenticated order queue; it does not approve or prepare an order.
- Delayed staff alerts are dropped if the request is no longer pending or has expired. Customer notifications are bounded by the existing order access window and recheck current state before sending.
- Redis coordinates limits across application instances: at most one send per 1.1 seconds/private chat, 3.1 seconds/group, and 40 milliseconds/bot. Production already requires Redis. Development/test without Redis uses a local limiter, not a distributed guarantee.
- HTTP/API `429` honors `parameters.retry_after` (60 seconds if invalid/missing) and applies a shared bot cooldown. The outbox defers delivery without sleeping in a worker or consuming the ordinary error retry budget. HTTP 400/401/404 and forbidden staff destinations go directly to dead-letter; blocked customer chats are unsubscribed. Transport/5xx failures retain the existing bounded exponential retry policy.
- Inspect dead-letter outbox events after changing bot permissions, token or group ID. Error messages omit Telegram response descriptions, destination IDs and credential-bearing URLs. Keep the existing outbox lag/dead-letter alerts enabled.

Delivery is **at least once**, not exactly once: Telegram can accept a message before a network timeout or a database acknowledgement failure. A retry may send the same short reference again. Do not use a Telegram message as an instruction to charge a customer or prepare a pending order. Webhook acknowledgements for `/start` and `/stop` remain best-effort; durable order state notifications use the outbox.

Readiness is reevaluated after either a ready item or a cancelled item. Cancelling
the last unready item can make the remaining order ready; cancelling every item
or handing off every remaining item does not send a ready notification. The
database compare-and-set and ready-event insert still commit together.

Malformed internal notification payloads go directly to dead-letter with a
sanitized error, not `PUBLISHED`. Valid but obsolete notifications remain safe
no-ops. The public Telegram webhook still ignores unsupported updates.

## Activation checklist

1. Configure credentials and the private group ID; restart the backend. Leave the feature unconfigured when unused. No new migration or seed is required.
2. Create one test takeaway request. Check one `online-order.telegram.staff-new` outbox event and one group message; replay the same request and verify there is no additional event.
3. Open the staff button while signed out, then sign in with the required permission. Verify it opens the order queue without bypassing RBAC.
4. Subscribe from a guest order, accept it, then mark all active items ready. Verify Vietnamese messages, COD wording and a lookup button without secrets. Repeat with an authenticated customer and verify ownership protection.
5. Block the bot to verify customer unsubscribe; remove it from the staff group to verify dead-letter handling. Restore access and explicitly replay only relevant non-stale events.

API reference: [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage), [delivery limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).
