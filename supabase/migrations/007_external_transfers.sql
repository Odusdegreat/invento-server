BEGIN;
SET LOCAL search_path TO invento, public;

-- Reference data rather than demo data: the catalogue must exist in every
-- environment so GET /external-banks answers on a freshly migrated database.
-- These are invented institutions; no real payment rail is represented.
CREATE TABLE external_banks (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  "minAmount" numeric(18,2) NOT NULL DEFAULT 1 CHECK("minAmount" > 0),
  "maxAmount" numeric(18,2) NOT NULL DEFAULT 1000000 CHECK("maxAmount" >= "minAmount"),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO external_banks (id, code, name, country, currency, "minAmount", "maxAmount") VALUES
  ('00000000-0000-4000-8000-000000000001', 'NORDSIM', 'Nordbank Simulated',    'NO', 'USD', 1,    250000),
  ('00000000-0000-4000-8000-000000000002', 'MERIDSIM','Meridian Simulated',    'GB', 'USD', 1,    250000),
  ('00000000-0000-4000-8000-000000000003', 'ATLASSIM','Atlas Simulated Trust',  'CA', 'USD', 5,    100000),
  ('00000000-0000-4000-8000-000000000004', 'PACRIMSIM','Pacific Simulated Union','AU', 'USD', 10,   50000),
  ('00000000-0000-4000-8000-000000000005', 'KRAALSIM','Kaap Simulated Bank',   'ZA', 'USD', 10,   50000);

CREATE TABLE external_transfers (
  id uuid PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES users,
  "fromAccountId" uuid NOT NULL,
  "externalBankId" uuid NOT NULL REFERENCES external_banks,
  -- The destination is snapshotted rather than joined through a saved
  -- recipient so history stays accurate if the catalogue changes.
  "accountNumber" text NOT NULL CHECK("accountNumber" ~ '^[0-9]{6,34}$'),
  "accountName" text NOT NULL,
  "transactionId" uuid UNIQUE REFERENCES transactions,
  "journalEntryId" uuid UNIQUE REFERENCES journal_entries,
  amount numeric(18,2) NOT NULL CHECK(amount > 0),
  fee numeric(18,2) NOT NULL DEFAULT 0 CHECK(fee >= 0),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  note text NOT NULL DEFAULT '',
  reference text NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN ('pending','completed','failed','cancelled')),
  -- Guards against a stale client cancelling a transfer that has moved on.
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "settledAt" timestamptz,
  "cancelledAt" timestamptz,
  "cancelJournalEntryId" uuid REFERENCES journal_entries,
  FOREIGN KEY("fromAccountId","userId") REFERENCES accounts(id,"userId"),
  -- A rejection moves no money. Every other state holds a journal entry.
  CHECK(status = 'failed' OR "journalEntryId" IS NOT NULL),
  CHECK(status <> 'cancelled' OR "cancelJournalEntryId" IS NOT NULL),
  CHECK(status <> 'cancelled' OR "cancelledAt" IS NOT NULL),
  -- Funds leave the account on creation for every state except a rejection, so
  -- the amount is only unreconciled while the transfer is still pending.
  CHECK(status <> 'completed' OR "settledAt" IS NOT NULL)
);

CREATE INDEX external_transfers_history ON external_transfers("userId","createdAt" DESC,id DESC);
CREATE INDEX external_transfers_bank ON external_transfers("externalBankId");

DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='invento'
    AND tablename IN ('external_banks','external_transfers') LOOP
    EXECUTE format('ALTER TABLE invento.%I ENABLE ROW LEVEL SECURITY',t.tablename);
    EXECUTE format('REVOKE ALL ON invento.%I FROM PUBLIC',t.tablename);
  END LOOP; END $$;

COMMIT;
