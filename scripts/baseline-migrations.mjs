import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { schemaSnapshot } from './schema-snapshot.mjs';

// Explicit recovery for databases initialized through SQL rather than the runner.
// Fail closed: never mark migrations applied just because a table exists.
const expected = JSON.parse(await readFile(new URL('./migration-baseline.json', import.meta.url), 'utf8'));
const names = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort();
const migrations = [];
for (const name of names) {
  const source = await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
  migrations.push({ name, checksum: createHash('sha256').update(source).digest('hex') });
}
if (JSON.stringify(migrations) !== JSON.stringify(expected.migrations)) throw new Error('Baseline does not match migration files; refusing to record history');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 10 });
try {
  await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(718103241)`;
    const actual = await schemaSnapshot(tx);
    const differences = Object.keys(expected.schema).filter(key => JSON.stringify(actual[key]) !== JSON.stringify(expected.schema[key]));
    if (differences.length) throw new Error('Existing schema differs from the baseline in: ' + differences.join(', ') + '. No history was changed.');
    if (!process.argv.includes('--apply')) {
      console.log('Schema matches all ' + migrations.length + ' migrations. Run with --apply to record migration history.');
      return;
    }
    await tx`create table if not exists public.invento_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())`;
    await tx`revoke all on public.invento_migrations from public`;
    await tx`alter table public.invento_migrations enable row level security`;
    for (const { name, checksum } of migrations) {
      const [existing] = await tx`select checksum from public.invento_migrations where name=${name}`;
      if (existing && existing.checksum !== checksum) throw new Error('Migration checksum differs: ' + name);
      await tx`insert into public.invento_migrations(name,checksum) values (${name},${checksum}) on conflict(name) do nothing`;
    }
  });
  if (process.argv.includes('--apply')) console.log('Recorded verified migration history. Existing application tables and data were unchanged.');
} finally {
  await sql.end();
}
