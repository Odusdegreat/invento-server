BEGIN;
CREATE SCHEMA IF NOT EXISTS invento;
REVOKE ALL ON SCHEMA invento FROM PUBLIC;
SET search_path TO invento, public;

CREATE TABLE users (
 id uuid PRIMARY KEY, "fullName" text NOT NULL, email text NOT NULL UNIQUE CHECK(email=lower(email)), phone text NOT NULL,
 "avatarUri" text, "memberSince" timestamptz NOT NULL DEFAULT now(), tier text NOT NULL DEFAULT 'standard' CHECK(tier IN ('standard','premium')),
 "kycVerified" boolean NOT NULL DEFAULT false, "passwordHash" text NOT NULL, "emailVerified" boolean NOT NULL DEFAULT false,
 "loginAttempts" integer NOT NULL DEFAULT 0, "loginLockedUntil" timestamptz
);
CREATE TABLE accounts (
 id uuid PRIMARY KEY, "userId" uuid NOT NULL REFERENCES users, name text NOT NULL, kind text NOT NULL,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), "maskedNumber" text NOT NULL, "interestRate" numeric NOT NULL DEFAULT 0,
 frozen boolean NOT NULL DEFAULT false, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE(id,"userId")
);
CREATE TABLE ledger_accounts (
 id uuid PRIMARY KEY, "accountId" uuid UNIQUE REFERENCES accounts, currency text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('customer','settlement','fee','investment','opening')), UNIQUE(purpose,currency,"accountId")
);
CREATE UNIQUE INDEX ledger_system_currency ON ledger_accounts(purpose,currency) WHERE "accountId" IS NULL;
CREATE TABLE journal_entries (id uuid PRIMARY KEY, reference text NOT NULL UNIQUE, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE postings (
 id uuid PRIMARY KEY, "journalEntryId" uuid NOT NULL REFERENCES journal_entries, "ledgerAccountId" uuid NOT NULL REFERENCES ledger_accounts,
 side text NOT NULL CHECK(side IN ('debit','credit')), "amountMinor" bigint NOT NULL CHECK("amountMinor">0), "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX postings_account ON postings("ledgerAccountId");
CREATE INDEX postings_journal ON postings("journalEntryId");
CREATE FUNCTION immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger_is_append_only'; END $$;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION immutable_ledger();
CREATE TRIGGER postings_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON postings FOR EACH STATEMENT EXECUTE FUNCTION immutable_ledger();
CREATE FUNCTION check_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE jid uuid; cnt integer; currencies integer; net numeric;
BEGIN
 IF TG_TABLE_NAME='journal_entries' THEN jid := NEW.id;
 ELSE jid := NEW."journalEntryId"; END IF;
 SELECT count(*), count(DISTINCT a.currency), sum(CASE p.side WHEN 'credit' THEN p."amountMinor" ELSE -p."amountMinor" END)
 INTO cnt,currencies,net FROM invento.postings p JOIN invento.ledger_accounts a ON a.id=p."ledgerAccountId" WHERE p."journalEntryId"=jid;
 IF cnt<2 OR currencies<>1 OR net<>0 THEN RAISE EXCEPTION 'unbalanced_journal'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal();
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT ON postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal();
-- A finalized journal cannot be extended in a later transaction.
CREATE FUNCTION prevent_late_posting() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM invento.journal_entries WHERE id=NEW."journalEntryId" AND xmin::text=pg_current_xact_id()::text) THEN RAISE EXCEPTION 'journal_already_finalized'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER posting_same_transaction BEFORE INSERT ON postings FOR EACH ROW EXECUTE FUNCTION prevent_late_posting();
CREATE TRIGGER ledger_account_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_accounts FOR EACH STATEMENT EXECUTE FUNCTION immutable_ledger();
CREATE VIEW account_balances AS SELECT a.id,coalesce(sum(CASE p.side WHEN 'credit' THEN p."amountMinor" ELSE -p."amountMinor" END),0)::bigint AS "balanceMinor"
 FROM accounts a LEFT JOIN ledger_accounts l ON l."accountId"=a.id LEFT JOIN postings p ON p."ledgerAccountId"=l.id GROUP BY a.id;

CREATE TABLE beneficiaries(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,name text NOT NULL,bank text NOT NULL,"accountNumber" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),"deletedAt" timestamptz);
CREATE TABLE transactions (
 id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"accountId" uuid NOT NULL, "journalEntryId" uuid NOT NULL UNIQUE REFERENCES journal_entries,
 amount numeric(18,2) NOT NULL CHECK(amount>0),fee numeric(18,2) NOT NULL DEFAULT 0 CHECK(fee>=0), currency text NOT NULL,
 kind text NOT NULL,category text NOT NULL,description text NOT NULL,counterparty text NOT NULL,"cardLast4" text,
 status text NOT NULL CHECK(status IN ('completed','pending','failed','reversed')),reference text NOT NULL UNIQUE,"createdAt" timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY("accountId","userId") REFERENCES accounts(id,"userId")
);
CREATE INDEX transaction_history ON transactions("userId","createdAt" DESC,id DESC);
CREATE TABLE transfers(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"fromAccountId" uuid NOT NULL,"beneficiaryId" uuid NOT NULL REFERENCES beneficiaries,"transactionId" uuid NOT NULL UNIQUE REFERENCES transactions,amount numeric(18,2) NOT NULL,fee numeric(18,2) NOT NULL,currency text NOT NULL,note text NOT NULL DEFAULT '',reference text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'completed',"createdAt" timestamptz NOT NULL DEFAULT now(),FOREIGN KEY("fromAccountId","userId") REFERENCES accounts(id,"userId"));
CREATE TABLE cards(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,brand text NOT NULL CHECK(brand IN ('visa','mastercard','amex','paystack','bank')),label text NOT NULL,last4 text NOT NULL CHECK(last4 ~ '^[0-9]{4}$'),expiry text NOT NULL CHECK(expiry ~ '^(0[1-9]|1[0-2])/[0-9]{2}$'),holder text NOT NULL,"isDefault" boolean NOT NULL DEFAULT false,frozen boolean NOT NULL DEFAULT false);
CREATE UNIQUE INDEX one_default_card ON cards("userId") WHERE "isDefault";
CREATE TABLE investment_products(id uuid PRIMARY KEY,ticker text NOT NULL UNIQUE,name text NOT NULL,"assetClass" text NOT NULL CHECK("assetClass" IN ('treasury','equity','etf','crypto','fixed-deposit')),currency text NOT NULL,price numeric(18,6) NOT NULL CHECK(price>0),"previousClose" numeric(18,6) NOT NULL CHECK("previousClose">0),"yieldPercent" numeric NOT NULL,risk text NOT NULL CHECK(risk IN ('low','medium','high')),provider text NOT NULL,description text NOT NULL,"pricedAt" timestamptz NOT NULL DEFAULT now(),tradable boolean NOT NULL DEFAULT true,"priceUnit" text NOT NULL DEFAULT 'unit');
CREATE TABLE price_history(id uuid PRIMARY KEY,"productId" uuid NOT NULL REFERENCES investment_products,price numeric(18,6) NOT NULL CHECK(price>0),"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE holdings(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"productId" uuid NOT NULL REFERENCES investment_products,units numeric(24,8) NOT NULL CHECK(units>=0),"averageCost" numeric(18,6) NOT NULL CHECK("averageCost">=0),"addedAt" timestamptz NOT NULL DEFAULT now(),UNIQUE("userId","productId"));
CREATE TABLE investment_orders(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"productId" uuid NOT NULL REFERENCES investment_products,"accountId" uuid NOT NULL REFERENCES accounts,"journalEntryId" uuid NOT NULL UNIQUE REFERENCES journal_entries,side text NOT NULL CHECK(side IN ('buy','sell')),units numeric(24,8) NOT NULL CHECK(units>0),price numeric(18,6) NOT NULL CHECK(price>0),total numeric(18,2) NOT NULL,fee numeric(18,2) NOT NULL CHECK(fee>=0),status text NOT NULL CHECK(status IN ('filled','pending','cancelled')),"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE watchlists("userId" uuid NOT NULL REFERENCES users,"productId" uuid NOT NULL REFERENCES investment_products,PRIMARY KEY("userId","productId"));
CREATE TABLE notifications(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,kind text NOT NULL CHECK(kind IN ('transaction','security','investment','system','promo')),title text NOT NULL,body text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),read boolean NOT NULL DEFAULT false,"targetType" text CHECK("targetType" IN ('transaction','investment','security','system')),"targetId" uuid);
CREATE TABLE security_settings("userId" uuid PRIMARY KEY REFERENCES users,"pinHash" text,"pinAttempts" integer NOT NULL DEFAULT 0,"pinLockedUntil" timestamptz,"twoFactorEnabled" boolean NOT NULL DEFAULT false,"biometricsEnabled" boolean NOT NULL DEFAULT false,"autoLock" integer NOT NULL DEFAULT 60 CHECK("autoLock">0),"transactionAlerts" boolean NOT NULL DEFAULT true,"loginAlerts" boolean NOT NULL DEFAULT true);
CREATE TABLE devices(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,name text NOT NULL,trusted boolean NOT NULL DEFAULT false,"createdAt" timestamptz NOT NULL DEFAULT now(),"lastActiveAt" timestamptz NOT NULL DEFAULT now(),"revokedAt" timestamptz,UNIQUE(id,"userId"));
CREATE TABLE refresh_tokens(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"deviceId" uuid NOT NULL,"tokenHash" text NOT NULL UNIQUE,"expiresAt" timestamptz NOT NULL,"revokedAt" timestamptz,FOREIGN KEY("deviceId","userId") REFERENCES devices(id,"userId"));
CREATE TABLE step_up_tokens(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"deviceId" uuid NOT NULL,"tokenHash" text NOT NULL UNIQUE,action text NOT NULL CHECK(action IN ('transfer','investment_order','beneficiary_add','pin_change','password_change','security_downgrade')),"expiresAt" timestamptz NOT NULL,"consumedAt" timestamptz,FOREIGN KEY("deviceId","userId") REFERENCES devices(id,"userId"));
CREATE TABLE preferences("userId" uuid PRIMARY KEY REFERENCES users,currency text NOT NULL DEFAULT 'USD' CHECK(currency ~ '^[A-Z]{3}$'));
CREATE TABLE disputes(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"transactionId" uuid NOT NULL REFERENCES transactions,reason text NOT NULL CHECK(reason IN ('not_recognised','wrong_amount')),status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved','rejected')),resolution text,"createdAt" timestamptz NOT NULL DEFAULT now(),UNIQUE("userId","transactionId"));
CREATE TABLE idempotency_keys("userId" uuid NOT NULL REFERENCES users,key text NOT NULL,"requestHash" text NOT NULL,response jsonb NOT NULL,PRIMARY KEY("userId",key));
CREATE TABLE password_reset_tokens(id uuid PRIMARY KEY,"userId" uuid NOT NULL REFERENCES users,"tokenHash" text NOT NULL UNIQUE,"expiresAt" timestamptz NOT NULL,"consumedAt" timestamptz);
-- Private schema, no browser access. Enable RLS as defence in depth; the backend
-- connects with a dedicated privileged database credential and scopes every query.
DO $$ DECLARE t record; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='invento' LOOP
 EXECUTE format('ALTER TABLE invento.%I ENABLE ROW LEVEL SECURITY',t.tablename);
 EXECUTE format('REVOKE ALL ON invento.%I FROM PUBLIC',t.tablename);
END LOOP; END $$;
COMMIT;
