import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { LedgerService } from '../dist/ledger/ledger.service.js';
import { FinanceService } from '../dist/api/finance.service.js';
import { passwordHash } from '../dist/auth/auth.service.js';
import { v7 as id } from 'uuid';
if (
  !process.env.SEED_DEMO_PASSWORD ||
  process.env.SEED_DEMO_PASSWORD.length < 8
)
  throw new Error('Set SEED_DEMO_PASSWORD (8+ characters)');
const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
});
try {
  const auth = app.get(AuthService),
    db = app.get(DatabaseService),
    ledger = app.get(LedgerService),
    finance = app.get(FinanceService);
  const email = process.env.SEED_DEMO_EMAIL ?? 'odue@inveto.app';
  const [existing] = await db.sql`select id from users where email=${email}`;
  const login = existing
    ? await auth.login({ email, password: process.env.SEED_DEMO_PASSWORD })
    : await auth.register({
        email,
        password: process.env.SEED_DEMO_PASSWORD,
        fullName: 'Odue Asare',
        phone: '+15550102288',
        deviceName: 'Demo setup',
      });
  const session = await auth.session(login.accessToken),
    pin = process.env.SEED_DEMO_PIN ?? '4826';
  if (!/^\d{4}$/.test(pin))
    throw new Error('SEED_DEMO_PIN must be four digits');
  const encoded = await passwordHash(pin);
  await db.sql.begin(async (tx) => {
    await auth.lock(tx, session);
    const [account] =
      await tx`select a.id,l.id as ledger from accounts a join ledger_accounts l on l."accountId"=a.id where a."userId"=${session.userId} order by a.id limit 1`;
    const reference = 'DEMO-OPENING-' + session.userId;
    const [funded] =
      await tx`select id from journal_entries where reference=${reference}`;
    if (!funded) {
      const opening = await ledger.system(tx, 'opening', 'USD');
      const journal = await ledger.post(tx, reference, [
        { accountId: opening, side: 'debit', amount: 2500000n },
        { accountId: account.ledger, side: 'credit', amount: 2500000n },
      ]);
      await tx`insert into transactions(id,"userId","accountId","journalEntryId",amount,currency,kind,category,description,counterparty,status,reference) values (${id()},${session.userId},${account.id},${journal},25000,'USD','in','income','Prototype opening balance','Invento demo','completed',${reference})`;
      await tx`update security_settings set "pinHash"=${encoded} where "userId"=${session.userId}`;
      await tx`insert into beneficiaries(id,"userId",name,bank,"accountNumber") values (${id()},${session.userId},'Ama Mensah','Demo Bank','001234567890')`;
      await tx`insert into cards(id,"userId",brand,label,last4,expiry,holder,"isDefault") values (${id()},${session.userId},'visa','Everyday demo','4242','12/29','Odue Asare',true)`;
      await tx`insert into notifications(id,"userId",kind,title,body,"targetType") values (${id()},${session.userId},'system','Welcome to Invento','Explore your simulated accounts and investments.','system')`;
    }
    for (const [ticker, name, assetClass, price, risk, yieldPercent] of [
      ['T-BILL-91', '91-day Treasury', 'treasury', 98.2, 'low', 5.1],
      ['DEMO-EQ', 'Demo Equity', 'equity', 125, 'high', 1.4],
      ['DEMO-ETF', 'Broad Market ETF', 'etf', 80, 'medium', 2.2],
      ['BTC', 'Simulated Bitcoin', 'crypto', 60000, 'high', 0],
      ['FD-12', '12-month Fixed Deposit', 'fixed-deposit', 100, 'low', 4.8],
    ]) {
      const productId = id();
      const rows =
        await tx`insert into investment_products(id,ticker,name,"assetClass",currency,price,"previousClose","yieldPercent",risk,provider,description,"priceUnit") values (${productId},${ticker},${name},${assetClass},'USD',${price},${Number(price) * 0.99},${yieldPercent},${risk},'Invento Simulator','Static prototype pricing. No live trading.',${assetClass === 'treasury' ? '100 face value' : 'unit'}) on conflict(ticker) do nothing returning id`;
      if (rows.length)
        await tx`insert into price_history(id,"productId",price) values (${id()},${productId},${price})`;
    }
  });
  const [product] =
    await db.sql`select id from investment_products where ticker='DEMO-ETF'`;
  const [holding] =
    await db.sql`select id from holdings where "userId"=${session.userId} and "productId"=${product.id}`;
  if (!holding) {
    const step = await auth.verifyPin(session, {
      pin,
      action: 'investment_order',
    });
    await finance.order(
      session,
      {
        productId: product.id,
        side: 'buy',
        units: 5,
        stepUpToken: step.stepUpToken,
      },
      'demo-initial-investment',
    );
  }
  const [sent] =
    await db.sql`select id from transfers where "userId"=${session.userId} limit 1`;
  if (!sent) {
    const [account] =
      await db.sql`select id from accounts where "userId"=${session.userId} order by id limit 1`;
    const [beneficiary] =
      await db.sql`select id from beneficiaries where "userId"=${session.userId} and "deletedAt" is null order by id limit 1`;
    if (beneficiary) {
      const step = await auth.verifyPin(session, { pin, action: 'transfer' });
      await finance.send(
        session,
        {
          fromAccountId: account.id,
          beneficiaryId: beneficiary.id,
          amount: 42.5,
          note: 'Demo lunch contribution',
          stepUpToken: step.stepUpToken,
        },
        'demo-initial-transfer',
      );
    }
  }
  await auth.logout(session);
  console.log(
    'Demo seeded for ' +
      email +
      '. PIN: ' +
      pin +
      '. Password: SEED_DEMO_PASSWORD.',
  );
} finally {
  await app.close();
}
