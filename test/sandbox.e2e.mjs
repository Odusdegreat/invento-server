import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
const url = process.env.TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Use an isolated local TEST_DATABASE_URL');
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: url, SANDBOX_ENABLED: 'true',
  SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  JWT_SECRET: 'test-only-secret-with-at-least-32-characters',
});
const { AppModule } = await import('../dist/app.module.js');
const { setupApplication } = await import('../dist/common/setup-application.js');
const { DatabaseService } = await import('../dist/database/database.service.js');
await test('complete simulated funding and two-user transfers', async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  setupApplication(app);
  await app.init();
  const http = request(app.getHttpServer());
  const call = (user, method, path, body, key) => {
    let req = http[method](path).set('Authorization', 'Bearer ' + user.accessToken);
    if (key) req = req.set('Idempotency-Key', key);
    return body === undefined ? req : req.send(body);
  };
  try {
    const people = [];
    for (const name of ['Alice Sandbox', 'Bob Sandbox']) {
      const password = 'Sandbox-test-password-4826';
      const r = await http.post('/auth/register').send({ email: randomUUID() + '@example.test', password, fullName: name, phone: '+15550102288' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const user = r.body;
      user.account = (await call(user, 'get', '/accounts')).body[0];
      const setup = await call(user, 'post', '/auth/pin/setup/verify', { password });
      assert.equal((await call(user, 'post', '/auth/pin/set', { pin: '4826', setupToken: setup.body.setupToken })).status, 200);
      people.push(user);
    }
    const [alice, bob] = people;
    const step = async (user, action = 'transfer') => (await call(user, 'post', '/auth/pin/verify', { pin: '4826', action })).body.stepUpToken;
    const balance = async user => (await call(user, 'get', '/accounts/' + user.account.id)).body.balance;
    const topUp = { accountId: alice.account.id, amount: 1000 };
    assert.equal((await http.post('/sandbox/top-ups').send(topUp)).status, 401);
    assert.equal((await call(bob, 'post', '/sandbox/top-ups', topUp, 'foreign-topup')).status, 404);
    const tops = await Promise.all([1, 2].map(() => call(alice, 'post', '/sandbox/top-ups', topUp, 'fund-once')));
    assert.equal(tops[0].status, 201, JSON.stringify(tops[0].body));
    assert.deepEqual(tops[0].body, tops[1].body);
    assert.equal(await balance(alice), 1000);
    assert.equal((await call(alice, 'post', '/sandbox/top-ups', { ...topUp, amount: 999 }, 'fund-once')).status, 409);
    const receiving = await call(bob, 'get', `/accounts/${bob.account.id}/receiving-details`);
    assert.equal(receiving.body.identifier, bob.account.id);
    assert.equal((await call(alice, 'get', `/transfers/recipients/${receiving.body.identifier}`)).body.name, 'Bob Sandbox');
    const input = { fromAccountId: alice.account.id, recipientAccountId: bob.account.id, amount: 100 };
    const quote = await call(alice, 'post', '/transfers/quote', input);
    assert.equal(quote.body.total, 101);
    assert.equal(quote.body.recipient.name, 'Bob Sandbox');
    assert.equal((await call(alice, 'post', '/transfers', input, 'no-pin-test')).body.code, 'step_up_required');
    const body = { ...input, stepUpToken: await step(alice) };
    const sent = await Promise.all([1, 2].map(() => call(alice, 'post', '/transfers', body, 'send-once')));
    assert.equal(sent[0].status, 201, JSON.stringify(sent[0].body));
    assert.deepEqual(sent[0].body, sent[1].body);
    assert.equal(await balance(alice), 899);
    assert.equal(await balance(bob), 100);
    const outgoing = (await call(alice, 'get', '/transactions')).body.find(x => x.reference === sent[0].body.reference);
    const incoming = (await call(bob, 'get', '/transactions')).body.find(x => x.reference === sent[0].body.reference);
    assert.equal(outgoing.kind, 'out'); assert.equal(incoming.kind, 'in');
    assert.equal(incoming.amount, 100); assert.equal(incoming.fee, 0); assert.equal(incoming.status, 'completed');
    assert.equal((await call(alice, 'get', '/transactions/' + incoming.id)).status, 404);
    assert.equal((await call(alice, 'post', '/transfers', { ...body, amount: 99 }, 'send-once')).status, 409);
    assert.equal((await call(alice, 'post', '/transfers', body, 'replayed-token')).body.code, 'invalid_step_up');
    await call(bob, 'patch', `/accounts/${bob.account.id}/freeze`);
    assert.equal((await call(alice, 'post', '/transfers', { ...input, stepUpToken: await step(alice) }, 'frozen-recipient')).body.code, 'account_frozen');
    await call(bob, 'patch', `/accounts/${bob.account.id}/unfreeze`);
    assert.equal((await call(alice, 'post', '/transfers', { ...input, amount: 1000, stepUpToken: await step(alice) }, 'too-much')).body.code, 'insufficient_funds');
    const opposite = await Promise.all(people.map(async (user, i) => call(user, 'post', '/transfers', {
      fromAccountId: user.account.id, recipientAccountId: people[1-i].account.id, amount: 10, stepUpToken: await step(user),
    }, 'opposite-direction')));
    assert.deepEqual(opposite.map(r => r.status), [201, 201]);
    const overspend = await Promise.all([1, 2].map(async i => call(alice, 'post', '/transfers', { ...input, amount: 500, stepUpToken: await step(alice) }, 'overspend-' + i)));
    assert.deepEqual(overspend.map(r => r.status).sort(), [201, 400]);
    const beneficiary = await call(alice, 'post', '/beneficiaries', { name: 'External Test', bank: 'Demo Bank', accountNumber: '1234567890', stepUpToken: await step(alice, 'beneficiary_add') });
    const before = await balance(alice);
    const failureBody = { fromAccountId: alice.account.id, beneficiaryId: beneficiary.body.id, amount: 10, simulationOutcome: 'failure', stepUpToken: await step(alice) };
    const failed = await call(alice, 'post', '/transfers', failureBody, 'external-failure');
    assert.equal(failed.status, 201, JSON.stringify(failed.body));
    assert.equal(failed.body.status, 'failed'); assert.equal(failed.body.debitedAmount, 0);
    assert.equal(await balance(alice), before);
    assert.deepEqual((await call(alice, 'post', '/transfers', failureBody, 'external-failure')).body, failed.body);
    assert.equal((await call(alice, 'get', '/transactions/' + failed.body.transactionId)).body.status, 'failed');
    const success = await call(alice, 'post', '/transfers', { ...failureBody, simulationOutcome: 'success', stepUpToken: await step(alice) }, 'external-success');
    assert.equal(success.body.status, 'completed'); assert.equal(await balance(alice), before - 11);
    const db = app.get(DatabaseService);
    const [invalid] = await db.sql`select count(*)::int as count from (select "journalEntryId" from postings group by "journalEntryId" having sum(case side when 'credit' then "amountMinor" else -"amountMinor" end)<>0) x`;
    assert.equal(invalid.count, 0);
    app.get(ConfigService).set('SANDBOX_ENABLED', 'false');
    assert.equal((await call(alice, 'post', '/sandbox/top-ups', topUp, 'disabled-test')).body.code, 'sandbox_disabled');
  } finally { await app.close(); }
});
