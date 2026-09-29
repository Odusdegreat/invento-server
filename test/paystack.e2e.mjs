import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
)
  throw new Error('Use an isolated local TEST_DATABASE_URL');
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: url,
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  JWT_SECRET: 'test-only-secret-with-at-least-32-characters',
  PAYSTACK_SECRET_KEY: 'sk_test_mock-only',
});
const { AppModule } = await import('../dist/app.module.js');
const { setupApplication } =
  await import('../dist/common/setup-application.js');
const { DatabaseService } =
  await import('../dist/database/database.service.js');
const { ConfigService } = await import('@nestjs/config');
await test('Paystack sandbox card linking and signed webhooks', async (t) => {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    rawBody: true,
  });
  setupApplication(app);
  await app.init();
  const http = request(app.getHttpServer()),
    db = app.get(DatabaseService);
  const originalFetch = globalThis.fetch;
  const records = new Map();
  let override = {},
    calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, 'Bearer sk_test_mock-only');
    if (url.endsWith('/initialize')) {
      const body = JSON.parse(options.body);
      assert.equal(body.amount, 10000);
      assert.deepEqual(body.channels, ['card']);
      records.set(body.reference, body);
      return Response.json({
        status: true,
        data: {
          reference: body.reference,
          authorization_url: 'https://checkout.paystack.com/mock',
        },
      });
    }
    const reference = url.split('/').at(-1),
      record = records.get(reference);
    return Response.json({
      status: true,
      data: {
        reference,
        domain: 'test',
        status: 'success',
        amount: 10000,
        currency: 'NGN',
        channel: 'card',
        customer: { email: record.email },
        authorization: {
          reusable: true,
          last4: '4081',
          exp_month: '12',
          exp_year: '2030',
          authorization_code: 'AUTH_must_not_be_stored',
        },
        ...override,
      },
    });
  };
  try {
    const register = async () => {
      const res = await http
        .post('/auth/register')
        .send({
          email: randomUUID() + '@example.test',
          password: 'Strong-test-password',
          fullName: 'Test User',
          phone: '+15550102288',
        });
      assert.equal(res.status, 201);
      return res.body;
    };
    const user = await register(),
      other = await register();
    const post = (path, body = {}, token = user.accessToken) =>
      http
        .post(path)
        .set('Authorization', 'Bearer ' + token)
        .send(body);
    const initialized = await post('/cards/link/initialize');
    assert.equal(initialized.status, 201);
    const { reference } = initialized.body;
    await t.test('ownership enforced before provider lookup', async () => {
      const before = calls;
      assert.equal(
        (await post('/cards/link/confirm', { reference }, other.accessToken))
          .status,
        404,
      );
      assert.equal(calls, before);
    });
    await t.test(
      'reject mismatched amount, email, currency and live transactions',
      async () => {
        for (const invalid of [
          { amount: 1 },
          { domain: 'live' },
          { currency: 'USD' },
          { customer: { email: 'other@example.test' } },
          { status: 'pending' },
        ]) {
          override = invalid;
          assert.equal(
            (await post('/cards/link/confirm', { reference })).status,
            400,
          );
        }
        override = {};
      },
    );
    await t.test(
      'signed raw-body webhook verifies and links once',
      async () => {
        const payload = JSON.stringify({
          event: 'charge.success',
          data: { reference },
        });
        const signature = createHmac('sha512', 'sk_test_mock-only')
          .update(payload)
          .digest('hex');
        assert.equal(
          (
            await http
              .post('/webhooks/paystack')
              .send(JSON.parse(payload))
          ).status,
          401,
        );
        assert.equal(
          (
            await http
              .post('/webhooks/paystack')
              .set('x-paystack-signature', '0'.repeat(128))
              .send(JSON.parse(payload))
          ).status,
          401,
        );
        const send = () =>
          http
            .post('/webhooks/paystack')
            .set('Content-Type', 'application/json')
            .set('x-paystack-signature', signature)
            .send(payload);
        assert.equal((await send()).status, 200);
        assert.equal((await send()).status, 200);
        const confirmed = await post('/cards/link/confirm', { reference });
        assert.equal(confirmed.status, 201);
        const rows =
          await db.sql`select * from cards where "userId"=${user.user.id}`;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, confirmed.body.cardId);
        assert.equal(rows[0].last4, '4081');
        assert.equal(JSON.stringify(confirmed.body).includes('AUTH_'), false);
        await db.sql`delete from cards where id=${rows[0].id}`;
        assert.equal(
          (await post('/cards/link/confirm', { reference })).body.cardId,
          null,
        );
        assert.equal(
          (await db.sql`select id from cards where "userId"=${user.user.id}`)
            .length,
          0,
        );
      },
    );
    await t.test(
      'live key is refused before any provider request',
      async () => {
        const config = app.get(ConfigService),
          before = calls;
        config.set('PAYSTACK_SECRET_KEY', 'sk_live_mock');
        assert.equal((await post('/cards/link/initialize')).status, 503);
        assert.equal(calls, before);
        config.set('PAYSTACK_SECRET_KEY', 'sk_test_mock-only');
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});
