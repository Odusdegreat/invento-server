BEGIN;
SET search_path TO invento,public;
CREATE TABLE fx_rates(currency text PRIMARY KEY CHECK(currency ~ '^[A-Z]{3}$'),"unitsPerUsd" numeric(24,8) NOT NULL CHECK("unitsPerUsd">0),"asOf" timestamptz NOT NULL DEFAULT now());
-- Explicitly simulated display rates, not executable market quotes.
INSERT INTO fx_rates(currency,"unitsPerUsd") VALUES ('USD',1),('EUR',0.9),('GBP',0.75),('GHS',15),('NGN',1500),('CAD',1.35),('AUD',1.5),('JPY',150),('CNY',7),('CHF',0.85),('ZAR',18);
CREATE TABLE email_verification_tokens(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,email text NOT NULL,"tokenHash" text NOT NULL UNIQUE,"expiresAt" timestamptz NOT NULL,"consumedAt" timestamptz);
CREATE TABLE auth_challenges(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"deviceId" uuid REFERENCES devices,purpose text NOT NULL CHECK(purpose IN ('pin_setup','mfa_login','webauthn_registration','webauthn_authentication')),"tokenHash" text NOT NULL UNIQUE,action text,payload jsonb NOT NULL DEFAULT '{}',"expiresAt" timestamptz NOT NULL,"consumedAt" timestamptz);
CREATE INDEX auth_challenges_user ON auth_challenges("userId");
CREATE TABLE mfa_credentials("userId" uuid PRIMARY KEY REFERENCES users,"secretEncrypted" text,"pendingEncrypted" text,"pendingExpiresAt" timestamptz,"lastCounter" bigint NOT NULL DEFAULT -1,attempts integer NOT NULL DEFAULT 0,"lockedUntil" timestamptz);
CREATE TABLE biometric_credentials(id text PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"publicKey" bytea NOT NULL,counter bigint NOT NULL DEFAULT 0,"deviceType" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),"revokedAt" timestamptz);
CREATE INDEX biometric_credentials_user ON biometric_credentials("userId");
CREATE TABLE push_tokens(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"deviceId" uuid NOT NULL REFERENCES devices,provider text NOT NULL CHECK(provider IN ('expo','fcm','apns')),token text NOT NULL UNIQUE,"createdAt" timestamptz NOT NULL DEFAULT now(),UNIQUE("deviceId",provider));
-- Old toggles represented preferences, not enrollment. Do not pretend they provide MFA.
UPDATE security_settings SET "twoFactorEnabled"=false,"biometricsEnabled"=false;
ALTER TABLE step_up_tokens DROP CONSTRAINT step_up_tokens_action_check;
ALTER TABLE step_up_tokens ADD CHECK(action IN ('transfer','investment_order','beneficiary_add','pin_change','password_change','security_downgrade','biometric_enroll','two_factor_setup'));
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['fx_rates','email_verification_tokens','auth_challenges','mfa_credentials','biometric_credentials','push_tokens'] LOOP
 EXECUTE format('ALTER TABLE invento.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON invento.%I FROM PUBLIC',t);
END LOOP; END $$;
COMMIT;
