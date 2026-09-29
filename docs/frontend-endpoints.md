# Frontend endpoint reference

Complete list of HTTP routes a web or mobile client should call. Consumer routes use the original unprefixed paths; there is no `/api` or `/v1` segment. The machine-readable contract is [openapi.json](openapi.json), Swagger UI is served at `/api/docs`, and behavioral detail lives in [mobile adapter notes](mobile-integration.md) and [endpoint completion](endpoint-completion.md).

Base URL is `http://localhost:3000` for local development (`PORT` in `.env`).

## Conventions

- Every route except the public list requires `Authorization: Bearer <accessToken>`. The token is the `accessToken` from login/register/refresh; the response also aliases it as `token`.
- Successful bodies are direct objects or arrays with no `data` wrapper. Errors are `{ code, message, requestId }`; `requestId` also arrives in the `X-Request-Id` header.
- A global limiter allows 120 requests per minute per client IP and answers `429 rate_limited` beyond that.
- Validation rejects unknown body fields. Only send keys listed below.
- CORS is restricted to `CORS_ORIGINS` (comma-separated browser origins). Native mobile requests are unaffected.

## Public routes

| Method | Path | Body |
| --- | --- | --- |
| GET | `/health` | — |
| POST | `/auth/register` | `{ email, password, fullName, phone, deviceName? }` |
| POST | `/auth/login` | `{ email, password, deviceName? }` |
| POST | `/auth/refresh` | `{ refreshToken }` |
| POST | `/auth/password/reset/request` | `{ email }` |
| POST | `/auth/password/reset/confirm` | `{ token, newPassword }` |
| POST | `/auth/email-verification/request` | `{ email }` |
| POST | `/auth/email-verification/confirm` | `{ token }` |
| POST | `/auth/2fa/login/verify` | `{ challengeToken, code }` |

`POST /auth/password-reset/request` and `POST /auth/password-reset/confirm` are accepted aliases of the two hyphenated reset paths.

When 2FA is enabled, `POST /auth/login` returns `{ requiresTwoFactor: true, challengeToken, expiresIn }` with no session tokens. Exchange the challenge at `/auth/2fa/login/verify` to receive the session.

## Auth, PIN, MFA and biometrics

| Method | Path | Body |
| --- | --- | --- |
| POST | `/auth/logout` | — |
| POST | `/auth/pin/verify` | `{ pin, action }` |
| POST | `/auth/pin/set` | `{ pin, confirmPin?, setupToken?, stepUpToken? }` |
| POST | `/auth/pin` | `{ pin, confirmPin?, stepUpToken? }` |
| POST | `/auth/password/change` | `{ current, next, stepUpToken? }` |
| POST | `/auth/pin/setup/verify` | `{ password, stepUpToken? }` |
| POST | `/auth/2fa/enroll` | `{ password, stepUpToken? }` |
| POST | `/auth/2fa/confirm` | `{ code }` |
| POST | `/auth/2fa/disable` | `{ password, code, stepUpToken? }` |
| POST | `/auth/biometric/registration/options` | `{ stepUpToken? }` |
| POST | `/auth/biometric/registration/verify` | `{ challengeToken, response }` |
| POST | `/auth/step-up/biometric/challenge` | `{ action }` |
| POST | `/auth/step-up/biometric` | `{ challengeToken, response }` |

`POST /auth/step-up/verify` is an alias of `/auth/pin/verify`, and `POST /auth/pin/change` is an alias of `/auth/pin`.

`POST /auth/pin/verify` returns `{ ok: true, stepUpToken, expiresIn: 120 }`. Pass the `stepUpToken` on the guarded operation. Completed operations consume the token; rolled-back operations do not.

`action` is one of `transfer`, `investment_order`, `beneficiary_add`, `pin_change`, `password_change`, `security_downgrade`, `biometric_enroll`, `two_factor_setup`.

Initial PIN setup is two steps: `POST /auth/pin/setup/verify` returns `{ setupToken, expiresIn: 120 }`, then `POST /auth/pin` with `{ pin, confirmPin?, setupToken }`. Later PIN changes require a `pin_change` step-up token from the current PIN. See [initial PIN setup](endpoint-completion.md#initial-pin-setup).

## Profile and preferences

| Method | Path | Body |
| --- | --- | --- |
| GET | `/users/me` | — |
| PATCH | `/users/me` | `{ fullName?, email?, phone? }` |
| GET | `/preferences` | — |
| PATCH | `/preferences` | `{ currency }` |

## Accounts

| Method | Path | Body |
| --- | --- | --- |
| GET | `/accounts` | — |
| GET | `/accounts/summary` | query `currency` (ISO-4217, default `USD`) |
| GET | `/accounts/total-balance` | — |
| GET | `/accounts/:id` | — |
| PATCH | `/accounts/:id` | `{ frozen }` |
| PATCH | `/accounts/:id/freeze` | — |
| PATCH | `/accounts/:id/unfreeze` | — |

`:id` values are UUIDv7. `GET /accounts/summary` is the only route that applies simulated display conversion and always reports `simulated: true`; it cannot be used to exchange funds.

## Cards

| Method | Path | Body |
| --- | --- | --- |
| GET | `/cards` | — |
| POST | `/cards` | `{ brand, label, last4, expiry, holder? }` |
| PATCH | `/cards` | `{ frozen }` (applies to all cards) |
| PATCH | `/cards/:id` | `{ label?, isDefault?, frozen? }` |
| PATCH | `/cards/:id/default` | — |
| PATCH | `/cards/:id/freeze` | — |
| PATCH | `/cards/:id/unfreeze` | — |
| POST | `/cards/freeze-all` | `{ frozen? }` |
| DELETE | `/cards/:id` | — |
| POST | `/cards/link/initialize` | — |
| POST | `/cards/link/confirm` | `{ reference }` |

`brand` is `visa`, `mastercard`, `amex`, `paystack` or `bank`; `expiry` is `MM/YY`. Cards are simulated and store only `last4`, never full PANs. The two `link` routes drive Paystack test-card linking; see [Paystack client flow](paystack.md).

## Transactions

| Method | Path | Body |
| --- | --- | --- |
| GET | `/transactions` | query `limit`, `before`, `accountId`, `category`, `kind`, `from`, `to` |
| GET | `/transactions/summary` | same query as above |
| GET | `/transactions/:id` | — |
| POST | `/transactions/:id/dispute` | `{ reason }` |

`kind` (also accepted as `type`) is `in` or `out`. `from` is inclusive and `to` is exclusive; use ISO-8601 timestamps with an explicit time zone. `reason` is `not_recognised` or `wrong_amount`. `POST /transactions/:id/disputes` is an accepted alias.

## Transfers

| Method | Path | Body |
| --- | --- | --- |
| POST | `/transfers/quote` | `{ fromAccountId, amount, currency? }` |
| POST | `/transfers` | `{ fromAccountId, beneficiaryId, amount, fee?, note?, stepUpToken? }` |
| GET | `/transfers/:id` | — |
| GET | `/transfers/:id/receipt` | — |

`POST /transfers` requires an `Idempotency-Key` header of 8-128 letters, digits, hyphens or underscores. Generate one key per logical transfer and reuse it for retries, including timeouts. An identical retry returns the original result; the same key with different content returns `409 conflict`.

## Beneficiaries

| Method | Path | Body |
| --- | --- | --- |
| GET | `/beneficiaries` | — |
| POST | `/beneficiaries` | `{ name, bank, accountNumber, stepUpToken? }` |
| DELETE | `/beneficiaries/:id` | — |

`accountNumber` is 6-34 digits. Adding a beneficiary requires a `beneficiary_add` step-up token.

## Investments

| Method | Path | Body |
| --- | --- | --- |
| GET | `/investments/products` | query `search`, `assetClass` |
| GET | `/investments/products/:id` | — |
| GET | `/investments/holdings` | — |
| GET | `/investments/portfolio` | — |
| GET | `/investments/orders` | — |
| GET | `/investments/orders/:id` | — |
| POST | `/investments/orders/quote` | `{ productId, side, units, price?, fee?, fromAccountId? }` |
| POST | `/investments/orders` | `{ productId, side, units, price?, fee?, fromAccountId?, stepUpToken? }` |
| GET | `/investments/watchlist` | — |
| POST | `/investments/watchlist/:id` | — |
| PUT | `/investments/watchlist/:id` | — |
| DELETE | `/investments/watchlist/:id` | — |

`assetClass` is `treasury`, `equity`, `etf`, `crypto` or `fixed-deposit`; `search` matches name and ticker literally. `side` is `buy` or `sell`. `POST /investments/orders` requires an `Idempotency-Key` header under the same rules as transfers. Omit `fromAccountId` to fund from the earliest account in the product currency. The watchlist is an array of product ID strings, and the order list returns the latest 100 entries.

## Dashboard and home

| Method | Path | Body |
| --- | --- | --- |
| GET | `/dashboard` | — |
| GET | `/dashboard/summary` | — |
| GET | `/dashboard/cash-flow` | — |
| GET | `/dashboard/spending` | — |
| GET | `/home/summary` | — |

All are authenticated; `investments/products` is also authenticated even though the catalogue itself is not user-specific. `/dashboard/summary` adds `netWorth`; `/dashboard/cash-flow` and `/dashboard/spending` return subsets. Dashboard dates are UTC and totals remain USD.

## Notifications

| Method | Path | Body |
| --- | --- | --- |
| GET | `/notifications` | query `limit` (1-100, default 50), `before` |
| GET | `/notifications/unread-count` | — |
| PATCH | `/notifications/read-all` | — |
| POST | `/notifications/read-all` | — |
| PATCH | `/notifications/:id` | — |
| PATCH | `/notifications/:id/read` | — |

The unread count is a bare JSON number. Notifications carry `kind`, `targetType` and `targetId`; map `targetType` to an in-app route.

## Security, devices and push

| Method | Path | Body |
| --- | --- | --- |
| GET | `/security` | — |
| PATCH | `/security` | `{ twoFactorEnabled?, biometricsEnabled?, autoLock?, transactionAlerts?, loginAlerts?, stepUpToken? }` |
| GET | `/security/devices` | — |
| DELETE | `/security/devices/:id` | — |
| POST | `/security/devices/:id/revoke` | — |
| GET | `/security/biometric-credentials` | — |
| DELETE | `/security/biometric-credentials/:id` | `{ stepUpToken? }` |
| POST | `/security/push-tokens` | `{ provider, token }` |
| DELETE | `/security/push-tokens/:id` | — |

`autoLock` is seconds between 15 and 3600. `provider` is `expo`, `fcm` or `apns`. Revoking a credential and downgrading a security preference both require a `security_downgrade` step-up token. Direct `PATCH /security` toggles cannot bypass 2FA enrollment or disable verification. Push registration currently reports `deliveryEnabled: false`; transport is not configured.

## Pagination

`GET /transactions` and `GET /notifications` return bare arrays and use cursor pagination. When a full page is returned the last item's ID is also sent in the `X-Next-Cursor` response header; pass it back as `before` for the next page. `X-Next-Cursor` is exposed to browsers by CORS.

## Server-only routes

These are not client-facing:

- `POST /webhooks/paystack` — Paystack server-to-server callback, verified with an HMAC signature in `x-paystack-signature`. The client completes linking through the two `cards/link` routes instead.
- `GET /api/docs` — Swagger UI for browsing the contract.
