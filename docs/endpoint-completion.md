# Endpoint completion and integration changes

Consumer routes use the original unprefixed paths. The earlier freeze/read/watchlist spellings remain supported. Health is at `/health` and Swagger is at `/api/docs`. The machine-readable contract is [openapi.json](openapi.json).

## Added resource behavior

- `PATCH /accounts/:id` accepts `{ frozen }`.
- `GET /accounts/summary?currency=EUR` returns balances grouped by currency plus `convertedTotal`, `simulated: true`, and `ratesAsOf`. The `fx_rates` table contains explicit sample display rates. These are not live quotes and cannot be used to exchange funds. Unsupported currencies fail instead of being silently ignored.
- Transaction history and summary accept `accountId`, `category`, `kind` or `type` (`in`/`out`), inclusive `from` and exclusive `to` ISO timestamps. Use timestamps with explicit time zones. Lists retain `limit`/`before` pagination.
- `PATCH /cards/:id` changes `label`, `isDefault`, and/or `frozen`; `PATCH /cards` changes all cards' frozen state. Cards remain simulated and store only `last4`, never full PANs or real provider tokens.
- Product lists support literal `search` over name/ticker and `assetClass` filtering.
- `POST /investments/orders/quote` uses the same pricing, fee and eligibility checks as execution; it does not reserve funds, consume confirmation, or guarantee a later price.
- `GET /investments/orders/:id` and `/investments/portfolio` are owner-scoped.
- Watchlist add supports PUT. Notification read supports `PATCH /notifications/:id`; read-all supports POST. Device revocation supports `POST /security/devices/:id/revoke`.
- Home and separate dashboard summary/cash-flow/spending routes return server calculations. Dashboard financial totals remain USD; account summary alone performs simulated display conversion.

## Email verification

Registration sends a verification message through the configured mail transport. `POST /auth/email-verification/request` accepts `{ email }` and returns `{ sent: true }` for known and unknown users. `POST /auth/email-verification/confirm` accepts `{ token }`. Tokens expire after 15 minutes, are stored hashed, are consumed once, and are bound to the specific email address. Profile and login responses expose `emailVerified`.

Set `EMAIL_VERIFICATION_URL` for an HTTPS page or `invento:`/`inveto:` deep link; the server adds `token` to its query. Otherwise the message contains the token. Test-mode delivery stays in `.tmp/mail`. A verified email is distinct from KYC. This prototype does not block ordinary account use while email verification is pending.

## Initial PIN setup

The previous recent-login shortcut has been replaced. With a bearer session:

1. `POST /auth/pin/setup/verify` with `{ password }` returns `{ setupToken, expiresIn: 120 }`.
2. `POST /auth/pin` (or `/auth/pin/set`) with `{ pin, confirmPin?, setupToken }` consumes that device-session-bound token and sets the initial PIN.
3. Later PIN changes require a `pin_change` step-up token from the current PIN. A setup token cannot change an existing PIN.

## Authenticator-app 2FA

Set `MFA_ENCRYPTION_KEY` to 32 random bytes encoded as 64 hex characters. A development key was added to the local ignored `.env` if none existed. Preserve it across deployments: changing it prevents decrypting enrolled secrets. Secrets use AES-256-GCM encryption; TOTP verification uses [OTPAuth](https://www.npmjs.com/package/otpauth).

1. Verify the PIN with action `two_factor_setup`.
2. `POST /auth/2fa/enroll` with `{ password, stepUpToken }` returns a secret and `otpauthUrl`. Display the URI as a QR code in the mobile app; never persist it in logs or analytics.
3. `POST /auth/2fa/confirm` with `{ code }` verifies the six-digit authenticator code and enables 2FA. Pending enrollment expires in five minutes. Other device sessions are revoked.
4. Subsequent password login returns `{ requiresTwoFactor: true, challengeToken, expiresIn: 300 }`, **without session tokens**. Submit `{ challengeToken, code }` to `POST /auth/2fa/login/verify` to receive the session.
5. Disable through `POST /auth/2fa/disable` with `{ password, code, stepUpToken }`, using a `security_downgrade` token.

Codes accept a one-step clock skew, cannot be reused after successful verification, and lock for 15 minutes after five failed attempts. Use a fresh code for each confirmation. Direct PATCH toggles cannot bypass enrollment or disable verification. There is no recovery-code/support recovery workflow yet; losing the authenticator requires an independently designed recovery process.

## Device confirmation using WebAuthn

Set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` to your actual associated domain and exact trusted origin. Local development defaults are `localhost` and `http://localhost:8081`. Production requires HTTPS. The backend uses [SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server), requiring user verification and a single-device credential; synced multi-device passkeys are rejected for this device-bound flow.

1. PIN-confirm action `biometric_enroll`.
2. `POST /auth/biometric/registration/options` with `{ stepUpToken }` returns `{ challengeToken, options, expiresIn }`.
3. Have a compatible WebAuthn client/authenticator create the credential, then POST `{ challengeToken, response }` to `/auth/biometric/registration/verify`.
4. For a sensitive action, POST `{ action }` to `/auth/step-up/biometric/challenge`. Have the authenticator sign the returned challenge, then POST `{ challengeToken, response }` to `/auth/step-up/biometric`.
5. A valid signature returns a normal action-scoped, single-use step-up token, never a login session. Challenges expire after two minutes and are consumed on verification attempts. RP ID, origin, user verification, credential ownership, signature and signature counter are checked.
6. List credentials at `GET /security/biometric-credentials`. Revoke through DELETE `/security/biometric-credentials/:id` with a `security_downgrade` step-up token.

WebAuthn proves authenticator user verification, which may use a device PIN or biometrics; it does not attest that a fingerprint specifically was used. The existing `expo-local-authentication` boolean is insufficient. Mobile still needs a compatible credential API and platform/domain association; this repo change does not implement native mobile enrollment UI. Tests use real generated cryptographic keys and signed assertions, not physical phone hardware.

## Push registration and provider-dependent work

`POST /security/push-tokens` registers `{ provider: "expo" | "fcm" | "apns", token }` for the current session. DELETE `/security/push-tokens/:id` removes an owned registration. The response explicitly reports `deliveryEnabled: false`; push transport/credentials are not configured.

Real payment/card tokenization, banking/investment execution, identity-verification providers and their webhooks remain excluded by the original simulation-only requirement. No placeholder webhooks accept unauthenticated fake financial events, and no simulated identity result sets `kycVerified` to true. These integrations need separately selected providers and authorization.

Paystack test card linking and its signed webhook are now implemented as a sandbox-only addition. See [Paystack setup and client flow](paystack.md). No real payment rails are enabled.

## Migration and verification

Run `bun run db:migrate` before running the updated API against Supabase. Migration `003_api_security.sql` adds the new tables and resets old 2FA/biometric preference flags because they never represented verified enrollment. It preserves users, balances and ledger history. This session applied it only to the isolated local test database.

Run `bun run docs:export`, then `bun run bruno:generate` to refresh the repository artifacts. `bun run test:e2e` now includes the new endpoint/security integration suite. Credentials and mail tokens used by tests are local-only, and no live email or payment is sent by the tests.
