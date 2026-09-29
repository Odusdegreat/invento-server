BEGIN;
SET LOCAL search_path TO invento, public;

CREATE TABLE demo_card_links (
  reference text PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('success', 'failed', 'pending')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "completedAt" timestamptz,
  "cardId" uuid REFERENCES cards(id) ON DELETE SET NULL
);
CREATE INDEX ON demo_card_links ("userId");

DROP TABLE IF EXISTS paystack_card_links;

COMMIT;