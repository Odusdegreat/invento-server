import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { schemaSnapshot } from '../scripts/schema-snapshot.mjs';
const url = process.env.TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Use an isolated local TEST_DATABASE_URL');
const expected = JSON.parse(await readFile(new URL('../scripts/migration-baseline.json', import.meta.url), 'utf8')).schema;
await test('migration baseline detects schema drift without changing data', async t => {
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    assert.deepEqual(await sql.begin('read only', schemaSnapshot), expected);
    for (const [section, change] of [
      ['columns', 'alter table invento.users alter column phone drop not null'],
      ['relations', 'alter table invento.users disable row level security'],
      ['constraints', 'alter table invento.users drop constraint users_email_check'],
      ['functions', "create or replace function invento.immutable_ledger() returns trigger language plpgsql as $$ begin return new; end $$"],
    ]) {
      await t.test('detects drift in ' + section, async () => {
        const rollback = new Error('rollback test change');
        await assert.rejects(sql.begin(async tx => {
          await tx.unsafe(change);
          const actual = await schemaSnapshot(tx);
          assert.notDeepEqual(actual[section], expected[section]);
          throw rollback;
        }), error => error === rollback);
      });
    }
    assert.deepEqual(await sql.begin('read only', schemaSnapshot), expected);
  } finally { await sql.end(); }
});
