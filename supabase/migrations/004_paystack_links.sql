BEGIN;
SET LOCAL search_path TO invento, public;
CREATE TABLE paystack_card_links (
  reference text PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "completedAt" timestamptz,
  "cardId" uuid REFERENCES cards(id) ON DELETE SET NULL
);
CREATE INDEX ON paystack_card_links ("userId");
ALTER TABLE paystack_card_links ENABLE ROW LEVEL SECURITY;
COMMIT;
