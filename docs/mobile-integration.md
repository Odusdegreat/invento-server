# Mobile adapter notes

The supplied source document is saved as `mobile-requirements.md`. Actual mobile TypeScript files were not supplied, so omitted response types cannot be verified exactly.

## Sessions and confirmations

Login/register return `{ user, token, accessToken, refreshToken, expiresIn }`; `token` aliases `accessToken`. Use secure storage and `Authorization: Bearer <accessToken>`. Rotate with `/auth/refresh`. Call `/auth/logout` before deleting local credentials.

First call `/auth/pin/setup/verify` with `{ password }`, then `/auth/pin/set` with `{ pin, confirmPin?, setupToken }`. Subsequent changes require old-PIN confirmation.

`POST /auth/pin/verify` (alias `/auth/step-up/verify`) requires `{ pin, action }`:

| Action | Value |
| --- | --- |
| Send money | `transfer` |
| Buy/sell | `investment_order` |
| Add beneficiary | `beneficiary_add` |
| Change PIN | `pin_change` |
| Change password | `password_change` |
| Disable security preference | `security_downgrade` |

The generic mock `verifyPin(pin)` cannot safely preserve its signature without action context. Pass the intended action from the confirmation flow. Response: `{ ok: true, stepUpToken, expiresIn: 120 }`. Completed operations consume the token; rolled-back operations do not.

Device-key proof and authenticator-app 2FA are now implemented; follow [the security flow guide](endpoint-completion.md). Do not send local biometric success as proof or store/replay the PIN.

## Money and lists

Generate an `Idempotency-Key` (8-128 letters, digits, hyphens or underscores) for each new transfer/order. Retain it for retries, including timeouts. Identical retries return the original result after confirmation consumption. Different content with the same key returns `conflict`.

Transfer fields remain `fromAccountId`, `beneficiaryId`, `amount`, optional `fee`, optional `note`, and `stepUpToken`. Order fields remain `productId`, `side`, `units`, optional `price`, optional `fee`, and `stepUpToken`. Optional `fromAccountId` chooses funding; otherwise the earliest account in the product currency is used. Server prices and fees win.

Transaction/notification lists return arrays and use `limit`, `before`, and `X-Next-Cursor`. Orders return the latest 100. Watchlist is an array of product ID strings. Unread count is a JSON number. IDs are UUIDv7; do not parse mock prefixes.

`/accounts/total-balance` returns `{ totalBalance, currency: "USD", balances: [{ currency, balance }] }`. Unwrap `totalBalance` in the adapter if the mock expects a number. There is no implicit FX or mixed-currency sum.

Freeze/default/delete/read mutations return `{ ok: true }`; account freeze also returns `frozen`. Refetch and notify the existing subscription system after writes.

## Assumptions pending actual mobile types

| Type | Chosen fields |
| --- | --- |
| Account | `name`, `kind: "current"`, `maskedNumber`, `interestRate`, `frozen`, `balance` |
| Transaction | `kind: "in" or "out"`; positive `amount` and separate `fee`; categories `income`, `transfer`, `investment` |
| Card | `isDefault`, `frozen`; holder defaults to the user's name |
| Security | `pinSet`, `twoFactorEnabled`, `biometricsEnabled`, `autoLock` (seconds), `transactionAlerts`, `loginAlerts` |
| Receipt | `id`, `fromAccountId`, `beneficiaryId`, `transactionId`, `amount`, `fee`, `total`, `currency`, `note`, `reference`, `status`, `createdAt`, `counterparty` |
| Dashboard | `currency`, `totalAccountBalance`, `portfolioValue`, `allTimeGain`, `netFlow7Days`, `monthToDate`, `spendingByCategory` |

Dashboard dates are UTC; cash flow includes fees. Portfolio gain combines realized sells, remaining unrealized gain and buy fees. Notifications use `kind`, `targetType`, `targetId`; the adapter maps them to routes.

Both supplied password-reset path spellings and singular/plural dispute paths are supported. Swagger lists aliases. Theme remains device-local. Preferences do not convert funds.

Consumer endpoints now support `/api/v1`; legacy routes remain aliases. See [endpoint completion](endpoint-completion.md) for date filters, summaries, order quotes, card edits, and the new email/PIN/MFA/WebAuthn flows.
