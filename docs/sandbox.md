# Sandbox money API

All amounts are simulated USD, expressed in major units (100 means $100), with at most two decimal places. No real payment, card, or bank connection is required. Use an isolated sandbox database and set `SANDBOX_ENABLED=true` in the backend environment. Apply migration `005_sandbox_transfers.sql` using `bun run db:migrate` before starting the updated server. The new funding and receiving features return HTTP 403 `sandbox_disabled` unless explicitly enabled. This flag does not convert or partition an existing live-money database.

## Coverage

| Requirement | Implementation |
| --- | --- |
| Add test funds | New `POST /sandbox/top-ups`, authenticated and idempotent |
| Share receiving details | New `GET /accounts/:id/receiving-details`; existing account UUID is the unique receiving identifier (not the masked number) |
| Resolve a recipient | New `GET /transfers/recipients/:identifier`; returns name, currency and frozen state |
| Transfer between test users | Extended `POST /transfers/quote` and `POST /transfers` with `recipientAccountId` |
| Updated balances/history | Existing `GET /accounts`, `/accounts/:id`, `/accounts/summary`, `/transactions`, `/transactions/:id`; internal transfers now credit the receiver and record both sides atomically |
| External transfers | Existing beneficiary-based transfers simulate settlement; new `simulationOutcome` controls success/failure |
| Receipt | Existing `GET /transfers/:id` and `/transfers/:id/receipt`, sender-only; recipient uses their incoming transaction |

## Two test users

Set `SEED_DEMO_PASSWORD` to a chosen password (8+ characters), optionally `SEED_DEMO_PIN` (default `4826`), then run `bun run db:seed:sandbox`. The script creates these users in the configured sandbox and prints their receiving identifiers:

| Email | Name | Password | Initial PIN |
| --- | --- | --- | --- |
| alice@sandbox.example.test | Alice Sandbox | Your `SEED_DEMO_PASSWORD` | `SEED_DEMO_PIN`, default `4826` |
| bob@sandbox.example.test | Bob Sandbox | Your `SEED_DEMO_PASSWORD` | `SEED_DEMO_PIN`, default `4826` |

Each gets a one-time $1,000 test top-up. Rerunning the seed does not add another opening balance or reset existing passwords/PINs. These users are created only when the seed runs against your database; they are not pre-provisioned on a deployed server.

## Authentication and PIN

All routes below except login/registration require `Authorization: Bearer <accessToken>`. Login as each user with `POST /auth/login`:

```json
{"email":"alice@sandbox.example.test","password":"<SEED_DEMO_PASSWORD>"}
```

The response contains `accessToken`, `refreshToken`, and `user`. Keep Alice and Bob's sessions separate. For fresh users, `POST /auth/register` accepts `email`, `password`, `fullName`, `phone` (international form, e.g. `+15550101001`). To set a PIN, first `POST /auth/pin/setup/verify` with `{"password":"..."}`, then `POST /auth/pin/set` with `{"pin":"4826","confirmPin":"4826","setupToken":"<returned token>"}`.

Before sending, `POST /auth/pin/verify` with `{"pin":"4826","action":"transfer"}` returns a short-lived `stepUpToken`. Include it in the transfer body. It is single-use, scoped to the user, device and action. Quotes, lookups, receiving details, balances and top-ups require no PIN. Do not pass a PIN directly to `/transfers`.

## End-to-end example

1. Login as Alice and Bob. `GET /accounts` returns each user's accounts, including `id`, `currency`, `balance`, and `maskedNumber`.
2. As Bob, call `GET /accounts/<bobAccountId>/receiving-details`. Share the returned `identifier`:

```json
{"identifier":"<bobAccountId UUID>","name":"Bob Sandbox","currency":"USD","frozen":false,"bank":"Invento Sandbox","simulated":true}
```

3. As Alice, call `GET /transfers/recipients/<bobAccountId>`; the response has the same shape. Show the resolved name before asking for confirmation. Lookup exposes no email, phone, balance, or credentials. Invalid UUID: 400; unknown account: 404.
4. Add money as Alice with `POST /sandbox/top-ups`, header `Idempotency-Key: alice-topup-0001`:

```json
{"accountId":"<aliceAccountId>","amount":1000}
```

Example response (201, assuming a zero opening balance):

```json
{"id":"<transactionId>","accountId":"<aliceAccountId>","amount":1000,"currency":"USD","status":"completed","reference":"TOP-<uuid>","balance":1000,"simulated":true}
```

Only the logged-in user's unfrozen USD account can be funded. Maximum per request: 1,000,000. Repeat the same key/body to safely retry; `balance` in the replay is the original snapshot, so fetch `/accounts` for current balances.

5. `POST /transfers/quote`:

```json
{"fromAccountId":"<aliceAccountId>","recipientAccountId":"<bobAccountId>","amount":100}
```

Response (201):

```json
{"amount":100,"fee":1,"total":101,"currency":"USD","sufficientFunds":true,"simulated":true,"recipient":{"identifier":"<bobAccountId>","name":"Bob Sandbox","currency":"USD","frozen":false,"bank":"Invento Sandbox","simulated":true}}
```

Quotes do not reserve funds. Fee is 0.75%, rounded to cents, minimum $1 and maximum $18. Submit rechecks the account, recipient and balance and computes its own fee. Maximum transfer amount: 1,000,000,000.

6. Obtain a transfer step-up token, then `POST /transfers`, header `Idempotency-Key: alice-transfer-0001`:

```json
{"fromAccountId":"<aliceAccountId>","recipientAccountId":"<bobAccountId>","amount":100,"note":"Test payment","stepUpToken":"<token>"}
```

Response (201; IDs and date are illustrative placeholders):

```json
{"id":"<transferId>","fromAccountId":"<aliceAccountId>","beneficiaryId":null,"recipientAccountId":"<bobAccountId>","transactionId":"<outgoingTransactionId>","amount":100,"fee":1,"total":101,"debitedAmount":101,"currency":"USD","note":"Test payment","reference":"INV-<uuid>","status":"completed","createdAt":"<ISO date>","counterparty":"Bob Sandbox","simulated":true}
```

7. Refresh both users' `/accounts` and `/transactions`. Alice is down $101; Bob is up $100. Their separate transactions share the same reference and `completed` status. Alice has `kind:"out"`, amount 100 and fee 1; Bob has `kind:"in"`, amount 100 and fee 0. Both receive notifications. Users cannot read each other's private transaction IDs. There is no currency conversion. Sending to the same account is rejected.

## External bank simulation

Use existing `POST /beneficiaries` with `name`, `bank`, numeric `accountNumber`, and a step-up token obtained with action `beneficiary_add`. The name is supplied by you; external bank account names are not verified. Quote with `fromAccountId` and `amount`, then submit with `beneficiaryId` instead of `recipientAccountId`:

```json
{"fromAccountId":"<aliceAccountId>","beneficiaryId":"<beneficiaryId>","amount":10,"simulationOutcome":"failure","stepUpToken":"<transfer token>"}
```

`simulationOutcome:"success"` (or omission) completes immediately, debits amount plus fee and credits only the simulated settlement ledger; it does not pay a real bank or another app user. `"failure"` returns a persisted transfer with HTTP 201, `status:"failed"`, `fee:0`, `debitedAmount:0`, and a failed outgoing history entry. No ledger postings or balance changes occur. `total` remains the requested amount for a failed transfer; use `debitedAmount` for actual movement. Failed records are excluded from cash-flow totals. Failure still requires sufficient funds and a valid PIN confirmation, which is consumed; retries with the same key return the same failure. Use a new key and confirmation token for a new attempt. Outcome controls cannot be used on internal transfers.

## Errors and retries

Error shape: `{"code":"insufficient_funds","message":"Insufficient funds"}`.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | validation_error | Invalid fields, missing/invalid idempotency key, both/neither recipient target, invalid outcome combination |
| 400 | invalid_amount | Amount outside supported limits |
| 400 | insufficient_funds | Available balance cannot cover amount plus fee |
| 400 | invalid_recipient | Sender and recipient account are the same |
| 400 | unsupported_currency | Only USD is supported |
| 401 | unauthorized | Missing, expired or revoked authentication |
| 403 | sandbox_disabled | Sandbox feature is not enabled |
| 403 | account_frozen | Sender or receiver account is frozen |
| 403 | step_up_required / invalid_step_up | Missing, expired, wrong-scope or consumed confirmation token |
| 404 | not_found | Account/recipient/beneficiary is absent or private resource is not owned by caller |
| 409 | conflict | Idempotency key reused with a different operation or payload |

Idempotency keys are 8–128 letters, digits, underscores or hyphens and are scoped to the user across money operations. Retry ambiguous timeouts using exactly the same key and business fields; do not generate a new key. Successful cached retries need no fresh step-up token. A reused confirmation token with a new key is rejected. Database transactions serialize competing sends and commit both users' balances/history together; failed validation rolls everything back.

Interactive route/DTO documentation: `/api/docs`; JSON: `/api/docs-json` and `docs/openapi.json`. Automated coverage: `test/sandbox.e2e.mjs` (local `TEST_DATABASE_URL` required).
