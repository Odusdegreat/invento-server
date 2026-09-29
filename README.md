# Invento prototype backend

NestJS, Bun scripts, ESM, and Supabase PostgreSQL. Transfers, cards and investments are simulated. Balances derive from immutable, balanced ledger postings. No real financial rails are connected.

## Setup

Requirements: Bun, Node.js 22+, and Supabase PostgreSQL (or a separate local PostgreSQL database for tests).

1. Run `bun install`.
2. Copy `.env.example` to `.env` only if you do not already have one. Set `SUPABASE_URL`, the backend-only `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, and a random `JWT_SECRET` of at least 32 characters. Remote database URLs require `sslmode=require` or verified TLS. Use Supabase's direct or session-pooler PostgreSQL connection string and URL-encode password characters.
3. Run `bun run db:migrate`. It creates the private `invento` schema and records migration checksums. Existing unrelated Supabase tables are untouched. Do not edit applied migrations.
4. Set `SEED_DEMO_PASSWORD` (8+ characters), then run `bun run db:seed`. Optional: `SEED_DEMO_EMAIL` and `SEED_DEMO_PIN`.
5. Run `bun run start:dev`.

On Windows, use `bun.cmd` if PowerShell blocks `bun.ps1`.

The demo login is `odue@inveto.app`, with your configured password and PIN `4826` unless overridden. Seed data includes a ledger-funded USD account, transfer, beneficiary, simulated card, all five investment asset classes, an ETF holding, price history and notifications. Re-running with the same credentials does not fund or buy twice. New registrations have zero balances and no PIN.

- Swagger: `http://localhost:3000/api/docs`
- OpenAPI: `http://localhost:3000/api/docs-json`
- Repository OpenAPI specification: [docs/openapi.json](docs/openapi.json). Regenerate with `bun run docs:export`; no running server or database is needed.
- Process liveness: `http://localhost:3000/health` (not database readiness)
- Bruno collection: `bruno/`

Never put database credentials, JWT signing secrets, or the Supabase service-role key in the mobile app. PostgreSQL handles atomic financial transactions; the Supabase admin client is separately initialized without persisted auth sessions.

## Financial behavior

Balances use credit minus debit postings in integer cents. PostgreSQL rejects unbalanced or mixed-currency journals, updates/deletions to postings or journals, additions to finalized journals, and negative customer balances. Corrections require reversing entries.

Transfers atomically validate ownership, beneficiary, account state, balance and confirmation; create transfer and transaction records; post principal and fee; add a notification; and store the idempotent result. Orders also update holdings in the transaction. Per-user locks serialize financial writes. Customer-ledger locks and deferred constraints defend the balance at database level.

Transfer fee: 0.75%, minimum 1, maximum 18. Buy: 0.75%, minimum 1. Sell: 0.5%, minimum 1. Fees round half-up to cents. Client fee/price fields are accepted but ignored. Simulated prices come from the server catalogue.

## Authentication

Passwords and PINs use salted Argon2id. Access JWTs expire after 15 minutes. Random refresh tokens expire after 30 days, are stored only as hashes, and rotate on use. Replay revokes the device session. Logout, device revocation and password changes invalidate access through a device-session check on every authenticated request.

PIN confirmation requires an authenticated session and an explicit action. Tokens last two minutes and are single-use, user-bound and device-session-bound. Five failed PIN or login attempts cause a 15-minute lockout. PINs never establish sessions. First PIN setup requires a password-confirmed, single-use setup token; later changes require a `pin_change` token. Password changes also verify the current password.

## Mobile contract

Read the [frontend endpoint reference](docs/frontend-endpoints.md) for the complete list of client-facing routes with request bodies, then the [adapter notes](docs/mobile-integration.md) and the [completed endpoint/security flows](docs/endpoint-completion.md). Consumer routes use the original unprefixed paths, such as `/accounts` and `/auth/login`. Successful bodies are direct objects/arrays, without a `data` wrapper. Errors are `{ code, message, requestId }`. Logs exclude secrets, bodies and query values. Request IDs are in `X-Request-Id`.

Transactions and notifications support `limit` (default 50, maximum 100) and `before` (UUID cursor). `X-Next-Cursor` indicates another page may exist. Transaction filters: `accountId`, `category`, `kind`. `/transactions/summary` returns completed lifetime inflow/outflow per currency.

## Verification

```powershell
bun.cmd run build
bun.cmd run test
bun.cmd run lint
$env:TEST_DATABASE_URL = 'postgresql://test_user:password@127.0.0.1:5432/invento_test'
bun.cmd run test:e2e
```

Apply migrations to that separate local test database first, using `DATABASE_URL` and the migration runner. Integration tests refuse non-local hosts and never truncate tables; each run creates unique test users. They test real HTTP handlers and PostgreSQL transactions using compiled ESM to preserve Nest decorator metadata.

Tests cover ownership, PIN scope/expiry/replay/lockout, transfer fees, concurrent overspending, rollback, ledger constraints, investment holdings, notifications, security downgrades, cards, preferences, disputes, password reset/change, refresh replay, device revocation and logout.

## Prototype boundaries

Paystack test card linking is available; see [setup and client flow](docs/paystack.md). Migration `004_paystack_links.sql` is required. The integration accepts test secrets only and does not fund account balances.

- Transactions and dashboard totals support USD. `/accounts/summary` can convert display totals using explicitly simulated sample rates; no actual currency exchange occurs.
- Prices are static simulations with `pricedAt`, `priceUnit` and `tradable`. No market feed, scheduler or trading calendar is integrated.
- Password reset uses Resend when `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are set. Use a verified sender address ([Resend sending documentation](https://resend.com/docs/api-reference/emails/send-email)). Optional `PASSWORD_RESET_URL` supplies an HTTPS page or `invento:`/`inveto:` deep link; the server adds its `token` query parameter. Without a URL, the email includes a single-use reset token. Tokens expire after 15 minutes. Development without Resend and all tests use `.tmp/mail`; production requires Resend configuration. Responses stay `{ sent: true }` for known/unknown addresses and delivery failures; failures are logged without recipient, token or provider body. Delivery is synchronous after database commit, with an eight-second timeout and no durable retry queue. Registration now sends email verification; configure `EMAIL_VERIFICATION_URL` for its link.
- Authenticator-app 2FA and signed WebAuthn device confirmation are implemented. Mobile enrollment/login/challenge UI and trusted domain configuration are required; see the security flow guide. Device-local fingerprint success is never accepted as proof.
- KYC defaults to false. Disputes are stored as `open`; there is no support-agent resolution API.
- Request rate limiting is in-process (120 requests/minute/IP). A shared limiter and deliberate proxy-trust configuration are needed for multiple instances.
- Push-token registration exists; push delivery, real card linking, real investments, identity-provider integrations and social login remain outside this prototype.
- Several exact mobile types were omitted from the document. Field assumptions are documented; exact drop-in compatibility still needs the actual mobile `src/types/index.ts` and `src/api/client.ts`.

Runtime routes are in `src/api/api.controller.ts`, `src/auth/auth.controller.ts`, and `src/app.module.ts`. Reads/updates use `ResourcesService`; money operations use `FinanceService` and `LedgerService`. Original empty feature-module scaffolds are not registered.
