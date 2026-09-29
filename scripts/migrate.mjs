import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
let appliedCount = 0;
try {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(718103241)`;
    await tx`create table if not exists public.invento_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())`;
    await tx`revoke all on public.invento_migrations from public`;
    await tx`alter table public.invento_migrations enable row level security`;
    for (const name of (
      await readdir(new URL('../supabase/migrations/', import.meta.url))
    )
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      const source = await readFile(
        new URL('../supabase/migrations/' + name, import.meta.url),
        'utf8',
      );
      const checksum = createHash('sha256').update(source).digest('hex');
      const [applied] =
        await tx`select checksum from public.invento_migrations where name=${name}`;
      if (applied) {
        if (applied.checksum !== checksum)
          throw new Error('Applied migration changed: ' + name);
        continue;
      }
      if (name === '001_foundation.sql') {
        const [existing] = await tx`select to_regclass('invento.users') as name`;
        if (existing.name) throw new Error('Existing invento schema has no foundation migration history. Run bun run db:baseline to verify it, then bun run db:baseline --apply to record verified history. No application tables were changed.');
      }
      await tx.unsafe(
        source.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''),
      );
      await tx`insert into public.invento_migrations(name,checksum) values (${name},${checksum})`;
      appliedCount++;
    }
  });
  console.log(appliedCount ? `Applied ${appliedCount} migrations successfully.` : 'Database is up to date; no pending migrations.');
} finally {
  await sql.end();
}
