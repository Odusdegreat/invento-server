import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
export type Tx = postgres.TransactionSql;
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly sql: postgres.Sql;
  readonly supabase;
  constructor(@Inject(ConfigService) config: ConfigService) {
    this.supabase = createClient(
      config.getOrThrow<string>('SUPABASE_URL'),
      config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
    this.sql = postgres(config.getOrThrow<string>('DATABASE_URL'), {
      max: 10,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 20,
      // postgres.js parses int2/int4/int8/float as numbers but leaves numeric
      // (oid 1700) as a string to preserve precision. Every money and rate
      // column here is numeric, so parse it once at the driver instead of
      // guessing from column names after the row has been read. `to: 0` keeps
      // the default behaviour of letting PostgreSQL infer each parameter's
      // type from context, so writes are unaffected.
      types: {
        money: {
          to: 0,
          from: [1700],
          serialize: (value: number) => '' + value,
          parse: (raw: string) => Number(raw),
        },
      },
      connection: { search_path: 'invento,public', statement_timeout: 15000 },
    });
  }
  async onModuleDestroy() {
    await this.sql.end({ timeout: 5 });
  }
}
