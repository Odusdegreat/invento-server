BEGIN;
SET search_path TO invento,public;
-- One journal/reference can appear in both customers' histories.
ALTER TABLE transactions DROP CONSTRAINT "transactions_journalEntryId_key";
ALTER TABLE transactions DROP CONSTRAINT transactions_reference_key;
ALTER TABLE transactions ADD UNIQUE("journalEntryId","accountId");
ALTER TABLE transactions ADD UNIQUE(reference,"accountId");
ALTER TABLE transactions ALTER COLUMN "journalEntryId" DROP NOT NULL;
ALTER TABLE transactions ADD CHECK(status='failed' OR "journalEntryId" IS NOT NULL);
ALTER TABLE transfers ALTER COLUMN "beneficiaryId" DROP NOT NULL;
ALTER TABLE transfers ADD COLUMN "recipientAccountId" uuid REFERENCES accounts;
ALTER TABLE transfers ADD CHECK (("beneficiaryId" IS NULL) <> ("recipientAccountId" IS NULL));
COMMIT;
