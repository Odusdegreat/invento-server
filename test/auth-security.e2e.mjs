import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { v7 as id } from 'uuid';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
)
  throw new Error('TEST_DATABASE_URL must be local and isolated');
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
let app, http, db, user;
const email = 'auth-' + id() + '@example.test',
  password = 'secure-test-password',
  pin = '4826';
const call = (method, path, body, access = user?.accessToken) => {
  let r = http[method](path);
  if (access) r = r.set('Authorization', 'Bearer ' + access);
  return body === undefined ? r : r.send(body);
};
before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  setupApplication(app);
  await app.init();
  db = app.get(DatabaseService);
  http = request(app.getHttpServer());
});
after(async () => {
  if (app) await app.close();
});
await test('authentication hardening', async (t) => {
  await t.test('register and update only provided fields', async () => {
    const r = await http
      .post('/auth/register')
      .send({ email, password, fullName: 'Original', phone: '+15550102288' });
    assert.equal(r.status, 201);
    user = r.body;
    assert.equal(
      (await call('patch', '/users/me', { fullName: 'Updated' })).body.fullName,
      'Updated',
    );
    assert.equal((await call('get', '/users/me')).body.email, email);
    assert.equal(
      (await call('patch', '/users/me', { phone: null })).status,
      400,
    );
    assert.equal(
      (await call('patch', '/security', { twoFactorEnabled: null })).status,
      400,
    );
    assert.equal(
      (
        await call('post', '/auth/pin/set', {
          pin,
          setupToken: (
            await call('post', '/auth/pin/setup/verify', { password })
          ).body.setupToken,
        })
      ).status,
      200,
    );
  });
  await t.test(
    'persisted PIN lockout blocks even correct PIN until expiry',
    async () => {
      for (let i = 0; i < 5; i++)
        assert.equal(
          (
            await call('post', '/auth/pin/verify', {
              pin: '0000',
              action: 'transfer',
            })
          ).body.code,
          'invalid_pin',
        );
      assert.equal(
        (await call('post', '/auth/pin/verify', { pin, action: 'transfer' }))
          .body.code,
        'invalid_pin',
      );
      const [row] =
        await db.sql`select "pinAttempts","pinLockedUntil" from invento.security_settings where "userId"=${user.user.id}`;
      assert.equal(row.pinAttempts, 5);
      assert.ok(new Date(row.pinLockedUntil) > new Date());
      await db.sql`update invento.security_settings set "pinLockedUntil"=now()-interval '1 minute' where "userId"=${user.user.id}`;
      assert.equal(
        (await call('post', '/auth/pin/verify', { pin, action: 'transfer' }))
          .status,
        200,
      );
    },
  );
  await t.test(
    'expired and cross-device confirmations fail; current device cannot be revoked',
    async () => {
      const verified = await call('post', '/auth/pin/verify', {
        pin,
        action: 'beneficiary_add',
      });
      await db.sql`update invento.step_up_tokens set "expiresAt"=now()-interval '1 second' where "userId"=${user.user.id}`;
      assert.equal(
        (
          await call('post', '/beneficiaries', {
            name: 'Demo',
            bank: 'Demo',
            accountNumber: '12345678',
            stepUpToken: verified.body.stepUpToken,
          })
        ).body.code,
        'invalid_step_up',
      );
      const fresh = await call('post', '/auth/pin/verify', {
        pin,
        action: 'beneficiary_add',
      });
      const second = (await http.post('/auth/login').send({ email, password }))
        .body;
      assert.equal(
        (
          await call(
            'post',
            '/beneficiaries',
            {
              name: 'Demo',
              bank: 'Demo',
              accountNumber: '12345678',
              stepUpToken: fresh.body.stepUpToken,
            },
            second.accessToken,
          )
        ).body.code,
        'invalid_step_up',
      );
      const devices = (await call('get', '/security/devices')).body;
      assert.equal(
        (
          await call(
            'delete',
            '/security/devices/' + devices.find((d) => d.current).id,
          )
        ).status,
        409,
      );
      const other = devices.find((d) => !d.current);
      assert.equal(
        (await call('delete', '/security/devices/' + other.id)).status,
        200,
      );
      assert.equal(
        (await call('get', '/users/me', undefined, second.accessToken)).status,
        401,
      );
    },
  );
  await t.test(
    'password change checks current password and confirmation; revokes sessions',
    async () => {
      const confirmed = await call('post', '/auth/pin/verify', {
        pin,
        action: 'password_change',
      });
      const next = 'changed-secure-password';
      assert.equal(
        (
          await call('post', '/auth/password/change', {
            current: 'wrong-password',
            next,
            stepUpToken: confirmed.body.stepUpToken,
          })
        ).body.code,
        'invalid_credentials',
      );
      assert.equal(
        (
          await call('post', '/auth/password/change', {
            current: password,
            next,
            stepUpToken: confirmed.body.stepUpToken,
          })
        ).status,
        200,
      );
      assert.equal((await call('get', '/users/me')).status, 401);
      assert.equal(
        (await http.post('/auth/login').send({ email, password })).status,
        401,
      );
      const login = await http
        .post('/auth/login')
        .send({ email, password: next });
      assert.equal(login.status, 200);
      user = login.body;
    },
  );
  await t.test(
    'password reset response does not expose token or account existence; token is single-use',
    async () => {
      const existing = await http
        .post('/auth/password-reset/request')
        .send({ email });
      const unknown = await http
        .post('/auth/password-reset/request')
        .send({ email: 'absent-' + id() + '@example.test' });
      assert.equal(existing.status, 200);
      assert.deepEqual(existing.body, { sent: true });
      assert.deepEqual(existing.body, unknown.body);
      const messages = await Promise.all(
        (await readdir('.tmp/mail')).map(async (name) =>
          JSON.parse(await readFile('.tmp/mail/' + name, 'utf8')),
        ),
      );
      const message = messages.find(
        (m) => m.to === email && m.purpose === 'password-reset',
      );
      assert.ok(message?.token);
      const newPassword = 'reset-secure-password';
      assert.equal(
        (
          await http
            .post('/auth/password-reset/confirm')
            .send({ token: message.token, newPassword })
        ).status,
        200,
      );
      assert.equal(
        (
          await http
            .post('/auth/password-reset/confirm')
            .send({ token: message.token, newPassword })
        ).status,
        403,
      );
      assert.equal((await call('get', '/users/me')).status, 401);
      assert.equal(
        (await http.post('/auth/login').send({ email, password: newPassword }))
          .status,
        200,
      );
    },
  );
});
