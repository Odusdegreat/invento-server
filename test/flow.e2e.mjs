import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { v7 as id } from 'uuid';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
)
  throw new Error(
    'TEST_DATABASE_URL must point to an isolated local PostgreSQL database',
  );
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: url,
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-server-key',
  JWT_SECRET: 'test-only-secret-with-at-least-32-characters',
  CORS_ORIGINS: 'http://localhost:8081',
});
const { AppModule } = await import('../dist/app.module.js');
const { setupApplication } =
  await import('../dist/common/setup-application.js');
const { DatabaseService } =
  await import('../dist/database/database.service.js');
const { LedgerService } = await import('../dist/ledger/ledger.service.js');
let app,
  db,
  ledger,
  http,
  user,
  other,
  account,
  beneficiary,
  product,
  transfer,
  token;
const email = 'flow-' + id() + '@example.test',
  password = 'A-test-password-4826',
  pin = '4826';
const call = (method, path, body, access = user?.accessToken, key) => {
  let req = http[method](path);
  if (access) req = req.set('Authorization', 'Bearer ' + access);
  if (key) req = req.set('Idempotency-Key', key);
  return body === undefined ? req : req.send(body);
};
const step = async (action) => {
  const r = await call('post', '/auth/pin/verify', { pin, action });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.stepUpToken;
};
before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  setupApplication(app);
  await app.init();
  db = app.get(DatabaseService);
  ledger = app.get(LedgerService);
  http = request(app.getHttpServer());
});
after(async () => {
  if (app) await app.close();
});
await test('registration ? transfer ? investment ? revocation, including adversarial cases', async (t) => {
  await t.test('health, docs, authentication and validation', async () => {
    assert.equal((await http.get('/health')).status, 200);
    assert.equal((await http.get('/api/docs-json')).status, 200);
    assert.equal((await http.get('/accounts')).status, 401);
    assert.equal(
      (
        await http.post('/auth/register').send({
          email,
          password,
          fullName: 'Demo',
          phone: '+15550102288',
          tier: 'premium',
        })
      ).status,
      400,
    );
    const registered = await http.post('/auth/register').send({
      email,
      password,
      fullName: 'Demo Customer',
      phone: '+15550102288',
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    user = registered.body;
    assert.equal(user.user.kycVerified, false);
    assert.equal('passwordHash' in user.user, false);
    const wrong = await http
      .post('/auth/login')
      .send({ email, password: 'wrong-password' });
    assert.equal(wrong.body.code, 'invalid_credentials');
    const login = await http.post('/auth/login').send({ email, password });
    assert.equal(login.status, 200);
    user = login.body;
    assert.equal((await call('get', '/users/me')).body.email, email);
    const registeredOther = await http.post('/auth/register').send({
      email: 'other-' + email,
      password,
      fullName: 'Other',
      phone: '+15550102289',
    });
    other = registeredOther.body;
  });
  await t.test(
    'accounts start at zero and opening funds enter through balanced postings',
    async () => {
      const accounts = await call('get', '/accounts');
      assert.equal(accounts.status, 200, JSON.stringify(accounts.body));
      account = accounts.body[0];
      assert.equal(account.balance, 0);
      const forbidden = await call(
        'get',
        '/accounts/' + account.id,
        undefined,
        other.accessToken,
      );
      assert.equal(forbidden.status, 404);
      await db.sql.begin(async (tx) => {
        const [customer] =
          await tx`select id from ledger_accounts where "accountId"=${account.id}`;
        const opening = await ledger.system(tx, 'opening', 'USD');
        await ledger.post(tx, 'TEST-' + id(), [
          { accountId: opening, side: 'debit', amount: 100000n },
          { accountId: customer.id, side: 'credit', amount: 100000n },
        ]);
      });
      assert.equal(
        (await call('get', '/accounts/' + account.id)).body.balance,
        1000,
      );
    },
  );
  await t.test(
    'PIN only issues action-scoped confirmations; beneficiary requires step-up',
    async () => {
      assert.equal(
        (
          await call('post', '/auth/pin/set', {
            pin,
            confirmPin: pin,
            setupToken: (
              await call('post', '/auth/pin/setup/verify', { password })
            ).body.setupToken,
          })
        ).status,
        200,
      );
      const missing = await call('post', '/beneficiaries', {
        name: 'Ama',
        bank: 'Demo Bank',
        accountNumber: '1234567890',
      });
      assert.equal(missing.body.code, 'step_up_required');
      const verified = await call('post', '/auth/pin/verify', {
        pin,
        action: 'beneficiary_add',
      });
      assert.equal(verified.status, 200);
      assert.equal('accessToken' in verified.body, false);
      const added = await call('post', '/beneficiaries', {
        name: 'Ama',
        bank: 'Demo Bank',
        accountNumber: '1234567890',
        stepUpToken: verified.body.stepUpToken,
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      beneficiary = added.body;
      const replay = await call('post', '/beneficiaries', {
        name: 'Replay',
        bank: 'Demo Bank',
        accountNumber: '1234567890',
        stepUpToken: verified.body.stepUpToken,
      });
      assert.equal(replay.body.code, 'invalid_step_up');
    },
  );
  await t.test(
    'quote, wrong scope, frozen account and insufficient funds do not move money',
    async () => {
      const quote = await call('post', '/transfers/quote', {
        fromAccountId: account.id,
        amount: 100,
      });
      assert.equal(quote.body.fee, 1);
      assert.equal(quote.body.total, 101);
      const bad = await call(
        'post',
        '/transfers',
        {
          fromAccountId: account.id,
          beneficiaryId: beneficiary.id,
          amount: 10,
          stepUpToken: await step('investment_order'),
        },
        user.accessToken,
        'wrong-scope',
      );
      assert.equal(bad.body.code, 'invalid_step_up');
      token = await step('transfer');
      await call('patch', '/accounts/' + account.id + '/freeze');
      const frozen = await call(
        'post',
        '/transfers',
        {
          fromAccountId: account.id,
          beneficiaryId: beneficiary.id,
          amount: 10,
          stepUpToken: token,
        },
        user.accessToken,
        'frozen-transfer',
      );
      assert.equal(frozen.body.code, 'account_frozen');
      await call('patch', '/accounts/' + account.id + '/unfreeze');
      const broke = await call(
        'post',
        '/transfers',
        {
          fromAccountId: account.id,
          beneficiaryId: beneficiary.id,
          amount: 2000,
          stepUpToken: token,
        },
        user.accessToken,
        'broke-transfer',
      );
      assert.equal(broke.body.code, 'insufficient_funds');
    },
  );
  await t.test(
    'send recomputes fee; retry is identical; replay and key mismatch fail',
    async () => {
      const input = {
        fromAccountId: account.id,
        beneficiaryId: beneficiary.id,
        amount: 100,
        fee: 0,
        stepUpToken: token,
        note: 'Test transfer',
      };
      const sent = await call(
        'post',
        '/transfers',
        input,
        user.accessToken,
        'transfer-once',
      );
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
      transfer = sent.body;
      assert.equal(transfer.fee, 1);
      const retry = await call(
        'post',
        '/transfers',
        input,
        user.accessToken,
        'transfer-once',
      );
      assert.deepEqual(retry.body, transfer);
      assert.equal(
        (
          await call(
            'post',
            '/transfers',
            { ...input, amount: 99 },
            user.accessToken,
            'transfer-once',
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await call(
            'post',
            '/transfers',
            input,
            user.accessToken,
            'transfer-replay',
          )
        ).body.code,
        'invalid_step_up',
      );
      assert.equal(
        (await call('get', '/accounts/' + account.id)).body.balance,
        899,
      );
      assert.equal(
        (await call('get', '/transfers/' + transfer.id + '/receipt')).body
          .reference,
        transfer.reference,
      );
      assert.equal(
        (await call('get', '/transactions/' + transfer.transactionId)).body
          .amount,
        100,
      );
      assert.equal(
        (
          await call(
            'get',
            '/transactions/' + transfer.transactionId,
            undefined,
            other.accessToken,
          )
        ).status,
        404,
      );
      const list = await call('get', '/transactions?limit=1');
      assert.equal(list.body.length, 1);
      assert.ok(list.headers['x-next-cursor']);
    },
  );
  await t.test(
    'database rejects imbalance, mutation, late postings and mixed currencies',
    async () => {
      const [customer] =
        await db.sql`select id from ledger_accounts where "accountId"=${account.id}`;
      await assert.rejects(
        db.sql.begin(async (tx) => {
          const j = id();
          await tx`insert into journal_entries(id,reference) values (${j},${id()})`;
          await tx`insert into postings(id,"journalEntryId","ledgerAccountId",side,"amountMinor") values (${id()},${j},${customer.id},'credit',1)`;
        }),
        /unbalanced_journal/,
      );
      await assert.rejects(
        db.sql`update postings set "amountMinor"=1`,
        /ledger_is_append_only/,
      );
      const [journal] = await db.sql`select id from journal_entries limit 1`;
      await assert.rejects(
        db.sql`insert into postings(id,"journalEntryId","ledgerAccountId",side,"amountMinor") values (${id()},${journal.id},${customer.id},'credit',1)`,
        /journal_already_finalized/,
      );
      await assert.rejects(
        db.sql.begin(async (tx) => {
          const euro = await ledger.system(tx, 'opening', 'EUR');
          await ledger.post(tx, id(), [
            { accountId: euro, side: 'debit', amount: 1n },
            { accountId: customer.id, side: 'credit', amount: 1n },
          ]);
        }),
        /unbalanced_journal/,
      );
    },
  );
  await t.test(
    'post-write rollback restores token and all ledger rows',
    async () => {
      const [customer] =
        await db.sql`select id from ledger_accounts where "accountId"=${account.id}`;
      await assert.rejects(
        db.sql.begin(async (tx) => {
          const settlement = await ledger.system(tx, 'settlement', 'USD');
          await ledger.post(tx, id(), [
            { accountId: customer.id, side: 'debit', amount: 10000000n },
            { accountId: settlement, side: 'credit', amount: 10000000n },
          ]);
        }),
        /negative_customer_balance/,
      );
      const rollbackToken = await step('transfer');
      const [{ count: before }] = await db.sql`select count(*) from postings`;
      const { AuthService } = await import('../dist/auth/auth.service.js'),
        auth = app.get(AuthService),
        session = await auth.session(user.accessToken);
      await assert.rejects(
        db.sql.begin(async (tx) => {
          await auth.lock(tx, session);
          await auth.consume(tx, session, 'transfer', rollbackToken);
          await tx`insert into journal_entries(id,reference) values (${id()},${id()})`;
          throw new Error('forced rollback');
        }),
        /forced rollback/,
      );
      const [{ count: after }] = await db.sql`select count(*) from postings`;
      assert.equal(before, after);
      const sent = await call(
        'post',
        '/transfers',
        {
          fromAccountId: account.id,
          beneficiaryId: beneficiary.id,
          amount: 1,
          stepUpToken: rollbackToken,
        },
        user.accessToken,
        'rollback-retry',
      );
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
    },
  );
  await t.test('concurrent overspend only commits once', async () => {
    const one = await step('transfer'),
      two = await step('transfer');
    const results = await Promise.all(
      [one, two].map((token, i) =>
        call(
          'post',
          '/transfers',
          {
            fromAccountId: account.id,
            beneficiaryId: beneficiary.id,
            amount: 500,
            stepUpToken: token,
          },
          user.accessToken,
          'concurrent-' + i,
        ),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.status).sort((a, b) => a - b),
      [201, 400],
    );
    assert.equal(
      results.find((r) => r.status === 400).body.code,
      'insufficient_funds',
    );
    assert.equal(
      (await call('get', '/accounts/' + account.id)).body.balance,
      393.25,
    );
  });
  await t.test(
    'buy/sell uses server price and updates holdings with balanced journals',
    async () => {
      product = id();
      await db.sql`insert into investment_products(id,ticker,name,"assetClass",currency,price,"previousClose","yieldPercent",risk,provider,description) values (${product},${'TEST-' + id()},'Test ETF','etf','USD',10,9,2,'medium','Simulator','Test')`;
      const bought = await call(
        'post',
        '/investments/orders',
        {
          productId: product,
          side: 'buy',
          units: 2,
          price: 0.01,
          fee: 0,
          stepUpToken: await step('investment_order'),
        },
        user.accessToken,
        'buy-once',
      );
      assert.equal(bought.status, 201, JSON.stringify(bought.body));
      assert.equal(bought.body.price, 10);
      assert.equal(bought.body.fee, 1);
      assert.equal(bought.body.total, 21);
      assert.equal(
        (await call('get', '/investments/holdings')).body[0].units,
        2,
      );
      const sold = await call(
        'post',
        '/investments/orders',
        {
          productId: product,
          side: 'sell',
          units: 1,
          stepUpToken: await step('investment_order'),
        },
        user.accessToken,
        'sell-once',
      );
      assert.equal(sold.status, 201, JSON.stringify(sold.body));
      assert.equal(
        (await call('get', '/investments/holdings')).body[0].units,
        1,
      );
      assert.equal(
        (await call('get', '/accounts/' + account.id)).body.balance,
        381.25,
      );
      const [invalid] =
        await db.sql`select count(*)::int as count from (select "journalEntryId" from postings group by "journalEntryId" having sum(case side when 'credit' then "amountMinor" else -"amountMinor" end)<>0) t`;
      assert.equal(invalid.count, 0);
    },
  );
  await t.test(
    'cards, watchlist, notifications, dashboard, preferences, disputes and security',
    async () => {
      const card = await call('post', '/cards', {
        brand: 'visa',
        label: 'Demo',
        last4: '4242',
        expiry: '12/29',
      });
      assert.equal(card.status, 201);
      assert.equal(card.body.holder, 'Demo Customer');
      assert.equal(
        (
          await call('post', '/cards', {
            brand: 'visa',
            label: 'Bad',
            last4: '4242',
            expiry: '12/29',
            number: '4242424242424242',
          })
        ).status,
        400,
      );
      assert.equal(
        (await call('patch', '/cards/' + card.body.id + '/freeze')).status,
        200,
      );
      assert.equal(
        (await call('delete', '/cards/' + card.body.id)).status,
        200,
      );
      await call('post', '/investments/watchlist/' + product);
      assert.deepEqual((await call('get', '/investments/watchlist')).body, [
        product,
      ]);
      const notifications = await call('get', '/notifications');
      assert.ok(notifications.body.length > 0);
      assert.equal('href' in notifications.body[0], false);
      await call('patch', '/notifications/read-all');
      assert.equal((await call('get', '/notifications/unread-count')).body, 0);
      const dashboard = await call('get', '/dashboard');
      assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
      assert.equal(dashboard.body.totalAccountBalance, 381.25);
      assert.equal(dashboard.body.netFlow7Days.length, 7);
      assert.equal(dashboard.body.allTimeGain, -2);
      const summary = await call('get', '/transactions/summary');
      assert.equal(summary.status, 200);
      assert.equal(summary.body[0].inflow, 9);
      assert.equal(summary.body[0].outflow, 627.75);
      await call('patch', '/preferences', { currency: 'GHS' });
      assert.equal((await call('get', '/preferences')).body.currency, 'GHS');
      assert.equal(
        (
          await call(
            'post',
            '/transactions/' + transfer.transactionId + '/dispute',
            { reason: 'not_recognised' },
          )
        ).status,
        201,
      );
      assert.equal(
        (await call('patch', '/security', { twoFactorEnabled: true })).body
          .code,
        'mfa_enrollment_required',
      );
      const sec = await call('get', '/security');
      assert.equal(sec.body.pinSet, true);
      assert.equal('pinHash' in sec.body, false);
      assert.equal(
        (await call('post', '/auth/step-up/biometric', {})).body.code,
        'validation_error',
      );
    },
  );
  await t.test(
    'refresh rotation, replay detection, logout and device revocation',
    async () => {
      const refreshed = await http
        .post('/auth/refresh')
        .send({ refreshToken: user.refreshToken });
      assert.equal(refreshed.status, 200);
      assert.equal(
        (
          await http
            .post('/auth/refresh')
            .send({ refreshToken: user.refreshToken })
        ).status,
        401,
      );
      assert.equal(
        (await call('get', '/accounts', undefined, refreshed.body.accessToken))
          .status,
        401,
      );
      const login = await http.post('/auth/login').send({ email, password });
      user = login.body;
      const devices = await call('get', '/security/devices');
      assert.ok(devices.body.some((d) => d.current));
      assert.equal((await call('post', '/auth/logout', {})).status, 200);
      assert.equal((await call('get', '/accounts')).status, 401);
      assert.equal(
        (
          await http
            .post('/auth/refresh')
            .send({ refreshToken: user.refreshToken })
        ).status,
        401,
      );
    },
  );
});
