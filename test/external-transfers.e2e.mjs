import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';

const url = process.env.TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Use an isolated local TEST_DATABASE_URL');
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: url,
  SANDBOX_ENABLED: 'true',
  RATE_LIMIT_PER_MINUTE: '600',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  JWT_SECRET: 'test-only-secret-with-at-least-32-characters',
});
const { AppModule } = await import('../dist/app.module.js');
const { setupApplication } = await import('../dist/common/setup-application.js');
const { DatabaseService } = await import('../dist/database/database.service.js');
const { ConfigService } = await import('@nestjs/config');

async function boot() {
  const app = await NestFactory.create(AppModule, { logger: false });
  setupApplication(app);
  await app.init();
  return app;
}

const register = async (http, name) => {
  const password = 'External-test-password-4826';
  const r = await http.post('/auth/register').send({
    email: randomUUID() + '@example.test',
    password,
    fullName: name,
    phone: '+15550103388',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const user = r.body;
  user.account = (await http.get('/accounts').set('Authorization', 'Bearer ' + user.accessToken)).body[0];
  const setup = await http
    .post('/auth/pin/setup/verify')
    .set('Authorization', 'Bearer ' + user.accessToken)
    .send({ password });
  await http
    .post('/auth/pin/set')
    .set('Authorization', 'Bearer ' + user.accessToken)
    .send({ pin: '4826', setupToken: setup.body.setupToken });
  return user;
};

const fund = async (http, user, amount, key) => {
  const r = await http
    .post('/sandbox/top-ups')
    .set('Authorization', 'Bearer ' + user.accessToken)
    .set('Idempotency-Key', key)
    .send({ accountId: user.account.id, amount, currency: 'USD' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

await test('external bank catalogue', async () => {
  const app = await boot();
  const http = request(app.getHttpServer());
  try {
    const user = await register(http, 'Catalogue Reader');
    const call = (method, path, body, key) => {
      let req = http[method](path).set('Authorization', 'Bearer ' + user.accessToken);
      if (key) req = req.set('Idempotency-Key', key);
      return body === undefined ? req : req.send(body);
    };
    const banks = await call('get', '/external-banks');
    assert.equal(banks.status, 200, JSON.stringify(banks.body));
    assert.equal(banks.body.length, 5);
    assert.equal(typeof banks.body[0].minAmount, 'number');
    assert.match(banks.body[0].code, /^[A-Z]+$/);
    const search = await call('get', '/external-banks?search=meridian');
    assert.equal(search.body.length, 1);
    assert.equal(search.body[0].code, 'MERIDSIM');
    assert.equal((await call('get', '/external-banks?search=zzzz')).body.length, 0);
    // The catalogue is behind authentication like every other route.
    assert.equal((await http.get('/external-banks')).status, 401);
  } finally {
    await app.close();
  }
});

await test('external transfer quoting, settlement, replay and cancellation', async () => {
  const app = await boot();
  const http = request(app.getHttpServer());
  try {
    const [alice, bob] = [await register(http, 'Alice External'), await register(http, 'Bob External')];
    // A new registration has no balance, so the sandbox funds the sender first.
    // The top-up response is in major units, not minor units.
    const topped = await fund(http, alice, 5000, 'fund-alice');
    assert.equal(topped.amount, 5000);
    const call = (user, method, path, body, key) => {
      let req = http[method](path).set('Authorization', 'Bearer ' + user.accessToken);
      if (key) req = req.set('Idempotency-Key', key);
      return body === undefined ? req : req.send(body);
    };
    const step = async (user) =>
      (await call(user, 'post', '/auth/pin/verify', { pin: '4826', action: 'transfer' })).body.stepUpToken;
    const balance = async (user) => (await call(user, 'get', '/accounts/' + user.account.id)).body.balance;
    const bankId = (await call(alice, 'get', '/external-banks')).body[0].id;
    const banks = (await call(alice, 'get', '/external-banks')).body;
    const capped = banks.find((b) => b.code === 'PACRIMSIM');
    const base = {
      fromAccountId: alice.account.id,
      externalBankId: bankId,
      accountNumber: '0123456789',
      amount: 100,
    };

    // Quoting is free of side effects and reports the transfer fee schedule.
    const quote = await call(alice, 'post', '/external-transfers/quote', base);
    assert.equal(quote.status, 201, JSON.stringify(quote.body));
    assert.equal(quote.body.amount, 100);
    assert.equal(quote.body.fee, 1);
    assert.equal(quote.body.total, 101);
    assert.equal(quote.body.sufficientFunds, true);
    assert.equal(quote.body.simulated, true);
    assert.equal(quote.body.bankCode, banks[0].code);

    // A bank-level limit failure carries the offending field so a form can
    // attach the message to the amount input.
    const tooSmall = await call(alice, 'post', '/external-transfers/quote', {
      ...base,
      externalBankId: capped.id,
      amount: 5,
    });
    assert.equal(tooSmall.status, 400);
    assert.equal(tooSmall.body.code, 'validation_error');
    assert.equal(tooSmall.body.key, 'amount');
    assert.equal(tooSmall.body.fields[0].key, 'amount');
    const tooLarge = await call(alice, 'post', '/external-transfers/quote', {
      ...base,
      amount: 2000000,
    });
    assert.equal(tooLarge.body.key, 'amount');

    // An unknown field is rejected and reported by name.
    const unknown = await call(alice, 'post', '/external-transfers/quote', { ...base, nope: 1 });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.key, 'nope');

    const unknownBank = await call(alice, 'post', '/external-transfers/quote', {
      ...base,
      externalBankId: randomUUID(),
    });
    assert.equal(unknownBank.body.code, 'not_found');

    // Money movement requires a step-up token and an idempotency key.
    const body = { ...base, accountName: 'Alice External', stepUpToken: await step(alice) };
    assert.equal((await call(alice, 'post', '/external-transfers', body, 'short')).status, 400);
    assert.equal((await call(alice, 'post', '/external-transfers', body)).body.code, 'validation_error');
    assert.equal((await call(alice, 'post', '/external-transfers', base, 'no-name')).body.code, 'validation_error');
    const foreign = await call(alice, 'post', '/external-transfers', { ...body, fromAccountId: bob.account.id }, 'foreign-account');
    assert.equal(foreign.body.code, 'not_found');

    const before = await balance(alice);
    // A step-up token is single use, so the settlement below gets its own.
    const settlementBody = { ...body, stepUpToken: await step(alice) };
    const sent = await Promise.all([1, 2].map(() => call(alice, 'post', '/external-transfers', settlementBody, 'send-once')));
    assert.equal(sent[0].status, 201, JSON.stringify(sent[0].body));
    assert.deepEqual(sent[0].body, sent[1].body);
    assert.equal(sent[0].body.status, 'completed');
    assert.equal(sent[0].body.total, 101);
    assert.equal(await balance(alice), before - 101);
    assert.equal((await call(alice, 'post', '/external-transfers', { ...body, amount: 99 }, 'send-once')).status, 409);

    const detail = await call(alice, 'get', '/external-transfers/' + sent[0].body.id);
    assert.equal(detail.body.bankName, sent[0].body.bankName);
    assert.equal(detail.body.version, 1);
    assert.equal((await call(bob, 'get', '/external-transfers/' + sent[0].body.id)).status, 404);

    const history = (await call(alice, 'get', '/external-transfers')).body;
    assert.equal(history.length, 1);
    assert.equal((await call(alice, 'get', '/external-transfers?status=completed')).body.length, 1);
    assert.equal((await call(alice, 'get', '/external-transfers?status=pending')).body.length, 0);
    assert.equal((await call(alice, 'get', '/external-transfers?accountId=' + bob.account.id)).status, 404);
    // The transfer is visible in the standard ledger-backed history too.
    assert.ok((await call(alice, 'get', '/transactions')).body.some((t) => t.reference === sent[0].body.reference));

    // A simulated rejection moves no money and cannot be cancelled.
    const rejected = await call(alice, 'post', '/external-transfers', { ...body, amount: 40, simulationOutcome: 'failure', stepUpToken: await step(alice) }, 'reject-once');
    assert.equal(rejected.body.status, 'failed');
    assert.equal(rejected.body.debitedAmount, 0);
    assert.equal(await balance(alice), before - 101);
    assert.equal((await call(alice, 'post', '/external-transfers/' + rejected.body.id + '/cancel', {})).status, 409);

    // A pending transfer holds funds until cancelled, and the reversal returns
    // the principal and the fee together.
    const held = await call(alice, 'post', '/external-transfers', { ...body, amount: 60, simulationOutcome: 'pending', stepUpToken: await step(alice) }, 'hold-once');
    assert.equal(held.body.status, 'pending');
    assert.equal(held.body.settledAt, null);
    const afterHold = await balance(alice);
    // The fee has a $1 floor, so $60 of principal costs $61 in total.
    assert.equal(held.body.fee, 1);
    assert.equal(afterHold, before - 101 - 61);
    const cancelled = await call(alice, 'post', '/external-transfers/' + held.body.id + '/cancel', {});
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.version, 2);
    assert.equal(cancelled.body.refundedAmount, 61);
    assert.equal(await balance(alice), before - 101);
    // Cancelling twice, or by another user, is refused rather than repeated.
    assert.equal((await call(alice, 'post', '/external-transfers/' + held.body.id + '/cancel', {})).status, 409);
    assert.equal((await call(alice, 'post', '/external-transfers/' + held.body.id + '/cancel', { version: 2 })).body.code, 'conflict');
    assert.equal((await call(bob, 'post', '/external-transfers/' + held.body.id + '/cancel', {})).status, 404);

    // A pending transfer whose version still matches is accepted, and a stale
    // version is refused without changing the status.
    const second = await call(alice, 'post', '/external-transfers', { ...body, amount: 20, simulationOutcome: 'pending', stepUpToken: await step(alice) }, 'hold-two');
    const staleVersion = await call(alice, 'post', '/external-transfers/' + second.body.id + '/cancel', { version: 9 });
    assert.equal(staleVersion.body.code, 'conflict');
    assert.equal(staleVersion.body.fields[0].key, 'version');
    assert.equal((await call(alice, 'get', '/external-transfers/' + second.body.id)).body.status, 'pending');
    const ok = await call(alice, 'post', '/external-transfers/' + second.body.id + '/cancel', { version: 1 });
    assert.equal(ok.body.status, 'cancelled');

    // A frozen account cannot move money.
    await call(alice, 'patch', '/accounts/' + alice.account.id + '/freeze');
    assert.equal((await call(alice, 'post', '/external-transfers/quote', base)).body.code, 'account_frozen');
    await call(alice, 'patch', '/accounts/' + alice.account.id + '/unfreeze');

    // Insufficient funds and a spent step-up token are both rejected.
    assert.equal((await call(alice, 'post', '/external-transfers', { ...body, amount: 100000, stepUpToken: await step(alice) }, 'too-much')).body.code, 'insufficient_funds');
    const token = await step(alice);
    const first = await call(alice, 'post', '/external-transfers', { ...body, amount: 5, stepUpToken: token }, 'burn-token');
    assert.equal(first.status, 201);
    assert.equal((await call(alice, 'post', '/external-transfers', { ...body, amount: 5, stepUpToken: token }, 'replay-token')).body.code, 'invalid_step_up');
    assert.equal((await call(alice, 'post', '/external-transfers', { ...base, accountName: 'No Token' }, 'no-token')).body.code, 'step_up_required');

    const db = app.get(DatabaseService);
    const [unbalanced] = await db.sql`select count(*)::int as count from (select "journalEntryId" from postings group by "journalEntryId" having sum(case side when 'credit' then "amountMinor" else -"amountMinor" end)<>0) x`;
    assert.equal(unbalanced.count, 0);
  } finally {
    await app.close();
  }
});

await test('route rate limits are enforced independently of the global allowance', async () => {
  const app = await boot();
  const http = request(app.getHttpServer());
  try {
    const user = await register(http, 'Rate Limited');
    const call = (method, path, body) => {
      const req = http[method](path).set('Authorization', 'Bearer ' + user.accessToken);
      return body === undefined ? req : req.send(body);
    };
    // The catalogue declares no rule, so it follows the global allowance.
    // Registration already spent 4 requests, so the budget is set to leave
    // exactly two more before the limiter answers.
    app.get(ConfigService).set('RATE_LIMIT_PER_MINUTE', 6);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await call('get', '/external-banks')).status);
    assert.deepEqual(statuses, [200, 200, 429, 429]);
    const limited = await call('get', '/accounts');
    assert.equal(limited.body.code, 'rate_limited');
  } finally {
    await app.close();
  }
});

await test('a route limit does not spend the global allowance', async () => {
  const app = await boot();
  const http = request(app.getHttpServer());
  try {
    const user = await register(http, 'Bucket Scoped');
    const get = (path) => http.get(path).set('Authorization', 'Bearer ' + user.accessToken);
    const bankId = (await get('/external-banks')).body[0].id;
    const quote = () =>
      http
        .post('/external-transfers/quote')
        .set('Authorization', 'Bearer ' + user.accessToken)
        .send({ fromAccountId: user.account.id, externalBankId: bankId, accountNumber: '0123456789', amount: 10 });

    // Exhausting the tighter per-route allowance must leave the global one
    // intact, otherwise a busy quote endpoint throttles the whole API.
    for (let i = 0; i < 20; i++) await quote();
    assert.equal((await quote()).status, 429);

    app.get(ConfigService).set('RATE_LIMIT_PER_MINUTE', 600);
    assert.equal((await get('/external-banks')).status, 200);
    assert.equal((await get('/accounts')).status, 200);
  } finally {
    await app.close();
  }
});
