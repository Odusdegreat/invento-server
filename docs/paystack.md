# Paystack sandbox card linking

Set `PAYSTACK_SECRET_KEY` to your `sk_test_...` secret in the server `.env`. Restart `bun dev` after changing it. Live secrets are refused. Apply migrations with `bun run db:migrate` before using these endpoints.

1. Authenticated `POST /cards/link/initialize` returns `reference`, `authorizationUrl`, `amount: 10000`, `currency: NGN`, and `testMode: true`. The amount is 100 NGN in minor units, exclusively in Paystack test mode.
2. Open `authorizationUrl` in the client and complete Paystack's test checkout.
3. Authenticated `POST /cards/link/confirm` with `{ "reference": "<returned reference>" }` verifies the transaction with Paystack and returns `cardId`. Retrieve the masked card with `GET /cards`.

Configure the Paystack **test** dashboard webhook URL to your publicly accessible HTTPS backend `/webhooks/paystack`. The handler validates HMAC-SHA512 against the exact raw body, re-verifies the transaction with Paystack, and safely handles duplicate delivery. Localhost needs a development HTTPS tunnel for webhook delivery; explicit confirmation works without webhooks. The callback URL can be configured in the Paystack dashboard.

Only server-created references belonging to the user can link a card. Verification checks the test domain, payment status, amount, currency, email and card channel. Repeated confirmation returns the existing card ID; if the card was deleted, it returns `cardId: null` and does not recreate it. Start a new checkout to link it again.

This stores masked card metadata only. Authorization codes, PANs and CVVs are not stored or returned. No balance funding, recurring charges, transfers, refunds or investment execution are connected to Paystack. Existing `POST /cards` remains a simulated card fixture endpoint. Other providers (identity verification, push delivery and investment execution) remain unconfigured.

Automated tests mock Paystack responses and exercise the HTTP routes against local PostgreSQL. They do not prove your key is accepted by Paystack or complete a real sandbox checkout.

Provider references: [Transactions API](https://paystack.com/docs/api/transaction/) and [webhook signatures](https://paystack.com/docs/payments/webhooks/).
