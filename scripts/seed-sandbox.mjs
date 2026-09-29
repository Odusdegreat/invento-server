import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { FinanceService } from '../dist/api/finance.service.js';
if (process.env.SANDBOX_ENABLED !== 'true') throw new Error('Set SANDBOX_ENABLED=true on an isolated sandbox database');
const password = process.env.SEED_DEMO_PASSWORD;
if (!password || password.length < 8) throw new Error('Set SEED_DEMO_PASSWORD (8+ characters)');
const pin = process.env.SEED_DEMO_PIN ?? '4826';
if (!/^\d{4}$/.test(pin)) throw new Error('SEED_DEMO_PIN must be four digits');
const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const auth = app.get(AuthService), db = app.get(DatabaseService), finance = app.get(FinanceService);
  for (const [email, fullName, phone] of [
    ['alice@sandbox.example.test', 'Alice Sandbox', '+15550101001'],
    ['bob@sandbox.example.test', 'Bob Sandbox', '+15550101002'],
  ]) {
    const [existing] = await db.sql`select id from users where email=${email}`;
    const login = existing ? await auth.login({ email, password }) : await auth.register({ email, password, fullName, phone });
    if (!login.accessToken) throw new Error('Seed user requires MFA; use a fresh sandbox');
    const session = await auth.session(login.accessToken);
    try {
      const [security] = await db.sql`select "pinHash" from security_settings where "userId"=${session.userId}`;
      if (!security.pinHash) {
        const setup = await auth.pinSetup(session, password);
        await auth.setPin(session, { pin, confirmPin: pin, setupToken: setup.setupToken });
      }
      const [account] = await db.sql`select id from accounts where "userId"=${session.userId} order by id limit 1`;
      await finance.topUp(session, { accountId: account.id, amount: 1000 }, 'sandbox-seed-opening-v1');
      console.log(JSON.stringify({ email, receivingIdentifier: account.id, currency: 'USD', password: 'SEED_DEMO_PASSWORD', pin: 'SEED_DEMO_PIN (default 4826; existing PINs preserved)' }));
    } finally { await auth.logout(session); }
  }
} finally { await app.close(); }
