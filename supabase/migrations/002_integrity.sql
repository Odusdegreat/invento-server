BEGIN;
SET search_path TO invento,public;
ALTER TABLE beneficiaries ADD UNIQUE(id,"userId");
ALTER TABLE transfers ADD FOREIGN KEY("beneficiaryId","userId") REFERENCES beneficiaries(id,"userId");
ALTER TABLE transactions ADD UNIQUE(id,"userId");
ALTER TABLE disputes ADD FOREIGN KEY("transactionId","userId") REFERENCES transactions(id,"userId");
ALTER TABLE investment_orders ADD FOREIGN KEY("accountId","userId") REFERENCES accounts(id,"userId");
ALTER TABLE investment_orders ADD COLUMN "realizedGain" numeric(18,2) NOT NULL DEFAULT 0;

CREATE FUNCTION lock_customer_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM invento.ledger_accounts WHERE id=NEW."ledgerAccountId" AND purpose='customer' FOR UPDATE;
 RETURN NEW;
END $$;
CREATE TRIGGER lock_customer_posting BEFORE INSERT ON postings FOR EACH ROW EXECUTE FUNCTION lock_customer_ledger();
CREATE FUNCTION nonnegative_customer_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance numeric; customer boolean;
BEGIN
 SELECT purpose='customer' INTO customer FROM invento.ledger_accounts WHERE id=NEW."ledgerAccountId";
 IF customer THEN
  SELECT sum(CASE side WHEN 'credit' THEN "amountMinor" ELSE -"amountMinor" END) INTO balance FROM invento.postings WHERE "ledgerAccountId"=NEW."ledgerAccountId";
  IF balance<0 THEN RAISE EXCEPTION 'negative_customer_balance'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER customer_balance_nonnegative AFTER INSERT ON postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nonnegative_customer_balance();
CREATE FUNCTION immutable_account_currency() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.currency IS DISTINCT FROM OLD.currency THEN RAISE EXCEPTION 'account_currency_is_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_currency_immutable BEFORE UPDATE OF currency ON accounts FOR EACH ROW EXECUTE FUNCTION immutable_account_currency();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['accounts','beneficiaries','cards','holdings','investment_orders','notifications','devices','refresh_tokens','step_up_tokens','password_reset_tokens'] LOOP
  EXECUTE format('CREATE INDEX %I ON invento.%I ("userId")',t||'_user',t);
 END LOOP;
END $$;
COMMIT;
