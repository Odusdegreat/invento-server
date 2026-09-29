# Existing schema without migration history

If tables were created through the SQL editor, `db:migrate` cannot know which files were applied. Do not delete tables or add `IF NOT EXISTS` throughout the migrations: either can conceal an incomplete schema.

For the complete schema represented by migrations 001–004:

```powershell
bun run db:baseline
bun run db:baseline --apply
bun run db:migrate
```

The first command compares database metadata with `scripts/migration-baseline.json`, generated from a local database with verified migration checksums. It checks tables, columns, defaults, nullability, constraints, indexes, triggers, function definitions, views, RLS flags and policies. It ignores only PostgreSQL 18's separate NOT NULL constraint entries (column nullability is still checked) and CRLF versus LF in function definitions.

`--apply` repeats the comparison and records the four migration names and checksums in `public.invento_migrations` within one transaction, protected by the migration runner's advisory lock. It never recreates application tables or resets customer data. It does not replay historical data updates or audit existing rows or database role grants. A partial or modified schema fails comparison and needs individual review. Changes to the migration files also invalidate this baseline.

Regression check: set a local `TEST_DATABASE_URL`, then run `node --test test/migration-baseline.e2e.mjs`. Test changes are rolled back.
