import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { v7 as id } from 'uuid';
import { TOTP, Secret } from 'otpauth';
import { isoCBOR } from '@simplewebauthn/server/helpers';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
)
  throw new Error('Use an isolated local TEST_DATABASE_URL');
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: url,
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  JWT_SECRET: 'test-only-secret-with-at-least-32-characters',
  MFA_ENCRYPTION_KEY: 'ab'.repeat(32),
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_ORIGIN: 'http://localhost:8081',
  CORS_ORIGINS: 'http://localhost:8081',
});
const { AppModule } = await import('../dist/app.module.js');
const { setupApplication } =
  await import('../dist/common/setup-application.js');
const { DatabaseService } =
  await import('../dist/database/database.service.js');
const { LedgerService } = await import('../dist/ledger/ledger.service.js');
let app,
  http,
  db,
  ledger,
  user,
  other,
  account,
  product,
  order,
  credentialId,
  keyPair;
const email = 'gaps-' + id() + '@example.test',
  password = 'Secure-gap-password',
  pin = '4826';
const call = (method, path, body, token = user?.accessToken, key) => {
  let r = http[method](path);
  if (token) r = r.set('Authorization', 'Bearer ' + token);
  if (key) r = r.set('Idempotency-Key', key);
  return body === undefined ? r : r.send(body);
};
const check = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
};
const step = async (action) =>
  check(await call('post', '/auth/step-up/verify', { pin, action }))
    .stepUpToken;
const mail = async (purpose) =>
  (
    await Promise.all(
      (await readdir('.tmp/mail')).map(async (file) =>
        JSON.parse(await readFile('.tmp/mail/' + file, 'utf8')),
      ),
    )
  )
    .filter((m) => m.to === email && m.purpose === purpose)
    .at(-1);
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
await test('missing endpoint contract and real security flows', async (t) => {
  await t.test(
    'registration, verification email, replay protection and first PIN proof',
    async () => {
      user = check(
        await call('post', '/auth/register', {
          email,
          password,
          fullName: 'Gap Customer',
          phone: '+15550102288',
        }),
        201,
      );
      assert.equal(user.user.emailVerified, false);
      const message = await mail('email-verification');
      assert.ok(message.token);
      check(
        await call('post', '/auth/email-verification/confirm', {
          token: message.token,
        }),
      );
      assert.equal(check(await call('get', '/users/me')).emailVerified, true);
      assert.equal(
        (
          await call('post', '/auth/email-verification/confirm', {
            token: message.token,
          })
        ).status,
        403,
      );
      assert.equal(
        (await call('post', '/auth/pin', { pin })).body.code,
        'step_up_required',
      );
      assert.equal(
        (
          await call('post', '/auth/pin/setup/verify', {
            password: 'incorrect',
          })
        ).status,
        403,
      );
      const proof = check(
        await call('post', '/auth/pin/setup/verify', { password }),
      );
      check(
        await call('post', '/auth/pin', { pin, setupToken: proof.setupToken }),
      );
      assert.equal(
        (await call('post', '/auth/pin', { pin, setupToken: proof.setupToken }))
          .body.code,
        'step_up_required',
      );
      other = check(
        await call('post', '/auth/register', {
          email: 'other-' + email,
          password,
          fullName: 'Other',
          phone: '+15550102289',
        }),
        201,
      );
    },
  );
  await t.test(
    'account summary, aliases, card edits and currency conversion are explicit simulations',
    async () => {
      account = check(await call('get', '/accounts'))[0];
      await db.sql.begin(async (tx) => {
        const [customer] =
          await tx`select id from ledger_accounts where "accountId"=${account.id}`;
        const opening = await ledger.system(tx, 'opening', 'USD');
        await ledger.post(tx, id(), [
          { accountId: opening, side: 'debit', amount: 100000n },
          { accountId: customer.id, side: 'credit', amount: 100000n },
        ]);
      });
      check(await call('patch', '/accounts/' + account.id, { frozen: true }));
      assert.equal(
        check(await call('get', '/accounts/' + account.id)).frozen,
        true,
      );
      check(await call('patch', '/accounts/' + account.id, { frozen: false }));
      const summary = check(
        await call('get', '/accounts/summary?currency=EUR'),
      );
      assert.equal(summary.convertedTotal, 900);
      assert.equal(summary.simulated, true);
      assert.equal(
        (await call('get', '/accounts/summary?currency=XXX')).status,
        400,
      );
      const card = check(
        await call('post', '/cards', {
          brand: 'visa',
          label: 'Old',
          last4: '4242',
          expiry: '12/29',
        }),
        201,
      );
      assert.equal(
        check(
          await call('patch', '/cards/' + card.id, {
            label: 'New',
            isDefault: true,
          }),
        ).label,
        'New',
      );
      assert.equal(
        (
          await call(
            'patch',
            '/cards/' + card.id,
            { label: 'Stolen' },
            other.accessToken,
          )
        ).status,
        404,
      );
      check(await call('patch', '/cards', { frozen: true }));
      assert.equal(check(await call('get', '/cards'))[0].frozen, true);
      check(await call('patch', '/cards', { frozen: false }));
    },
  );
  await t.test(
    'search, product filters, order quote and details, portfolio and dashboard routes',
    async () => {
      product = id();
      await db.sql`insert into investment_products(id,ticker,name,"assetClass",currency,price,"previousClose","yieldPercent",risk,provider,description) values (${product},${'GAP-' + id()},'Gap ETF','etf','USD',10,9,2,'medium','Simulator','Test')`;
      assert.ok(
        check(
          await call('get', '/investments/products?search=Gap&assetClass=etf'),
        ).some((p) => p.id === product),
      );
      assert.equal(
        check(
          await call(
            'get',
            '/investments/products?search=Gap&assetClass=crypto',
          ),
        ).length,
        0,
      );
      const quote = check(
        await call('post', '/investments/orders/quote', {
          productId: product,
          side: 'buy',
          units: 2,
          price: 0,
          fee: 0,
        }),
        201,
      );
      assert.equal(quote.price, 10);
      assert.equal(quote.total, 21);
      assert.equal(
        check(await call('get', '/accounts/' + account.id)).balance,
        1000,
      );
      order = check(
        await call(
          'post',
          '/investments/orders',
          {
            productId: product,
            side: 'buy',
            units: 2,
            stepUpToken: await step('investment_order'),
          },
          user.accessToken,
          'gaps-buy-order',
        ),
        201,
      );
      assert.equal(
        check(await call('get', '/investments/orders/' + order.id)).status,
        'filled',
      );
      assert.equal(
        (
          await call(
            'get',
            '/investments/orders/' + order.id,
            undefined,
            other.accessToken,
          )
        ).status,
        404,
      );
      const portfolio = check(await call('get', '/investments/portfolio'));
      assert.equal(portfolio.portfolioValue, 20);
      assert.equal(portfolio.allTimeGain, -1);
      check(await call('put', '/investments/watchlist/' + product), 200);
      check(await call('put', '/investments/watchlist/' + product), 200);
      assert.equal(
        check(await call('get', '/investments/watchlist')).length,
        1,
      );
      assert.equal(
        check(await call('get', '/home/summary')).recentTransactions.length,
        1,
      );
      assert.equal(
        check(await call('get', '/dashboard/summary')).netWorth,
        999,
      );
      assert.equal(
        check(await call('get', '/dashboard/cash-flow')).days.length,
        7,
      );
      assert.equal(
        check(await call('get', '/dashboard/spending')).categories[0].category,
        'investment',
      );
    },
  );
  await t.test(
    'date/type filters, notifications and push token ownership',
    async () => {
      assert.equal(
        check(
          await call(
            'get',
            '/transactions?type=out&from=2000-01-01&to=2100-01-01',
          ),
        ).length,
        1,
      );
      assert.equal(check(await call('get', '/transactions?type=in')).length, 0);
      assert.equal(
        (await call('get', '/transactions?from=2100-01-01&to=2000-01-01'))
          .status,
        400,
      );
      assert.equal(
        (await call('get', '/transactions?kind=in&type=out')).status,
        400,
      );
      assert.equal(
        check(await call('get', '/transactions/summary?type=out'))[0].outflow,
        21,
      );
      const notification = check(await call('get', '/notifications'))[0];
      check(await call('patch', '/notifications/' + notification.id));
      check(await call('post', '/notifications/read-all'), 201);
      assert.equal(check(await call('get', '/notifications/unread-count')), 0);
      const push = check(
        await call('post', '/security/push-tokens', {
          provider: 'expo',
          token: 'ExponentPushToken[' + id() + ']',
        }),
        201,
      );
      assert.equal(push.deliveryEnabled, false);
      assert.equal(
        (
          await call(
            'delete',
            '/security/push-tokens/' + push.id,
            undefined,
            other.accessToken,
          )
        ).status,
        404,
      );
      check(await call('delete', '/security/push-tokens/' + push.id));
    },
  );
  await t.test(
    'authenticator enrollment, login challenge, code replay, and secure disable',
    async () => {
      assert.equal(
        (await call('patch', '/security', { twoFactorEnabled: true })).body
          .code,
        'mfa_enrollment_required',
      );
      const enrollment = check(
        await call('post', '/auth/2fa/enroll', {
          password,
          stepUpToken: await step('two_factor_setup'),
        }),
      );
      const totp = new TOTP({
        secret: Secret.fromBase32(enrollment.secret),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      });
      check(
        await call('post', '/auth/2fa/confirm', {
          code: totp.generate({ timestamp: Date.now() - 30000 }),
        }),
      );
      assert.equal(
        check(await call('get', '/security')).twoFactorEnabled,
        true,
      );
      const login = check(
        await call('post', '/auth/login', { email, password }),
      );
      assert.equal(login.requiresTwoFactor, true);
      assert.equal('accessToken' in login, false);
      const code = totp.generate();
      const verified = check(
        await call('post', '/auth/2fa/login/verify', {
          challengeToken: login.challengeToken,
          code,
        }),
      );
      assert.ok(verified.accessToken);
      assert.equal(
        (
          await call('post', '/auth/2fa/login/verify', {
            challengeToken: login.challengeToken,
            code,
          })
        ).status,
        401,
      );
      assert.equal(
        (await call('patch', '/security', { twoFactorEnabled: false })).body
          .code,
        'mfa_enrollment_required',
      );
      check(
        await call('post', '/auth/2fa/disable', {
          password,
          code: totp.generate({ timestamp: Date.now() + 30000 }),
          stepUpToken: await step('security_downgrade'),
        }),
      );
      assert.equal(
        check(await call('get', '/security')).twoFactorEnabled,
        false,
      );
    },
  );
  await t.test(
    'real WebAuthn registration and signed step-up, scope, replay and revocation',
    async () => {
      const options = check(
        await call('post', '/auth/biometric/registration/options', {
          stepUpToken: await step('biometric_enroll'),
        }),
      );
      keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = keyPair.publicKey.export({ format: 'jwk' });
      const rawId = randomBytes(32);
      credentialId = rawId.toString('base64url');
      const cose = isoCBOR.encode(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x, 'base64url')],
          [-3, Buffer.from(jwk.y, 'base64url')],
        ]),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(rawId.length);
      const authData = Buffer.concat([
        createHash('sha256').update('localhost').digest(),
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        rawId,
        cose,
      ]);
      const client = Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: options.options.challenge,
          origin: 'http://localhost:8081',
          crossOrigin: false,
        }),
      );
      const attestation = isoCBOR.encode(
        new Map([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      const registration = {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString('base64url'),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal'],
        },
      };
      check(
        await call('post', '/auth/biometric/registration/verify', {
          challengeToken: options.challengeToken,
          response: registration,
        }),
      );
      assert.equal(
        check(await call('get', '/security')).biometricsEnabled,
        true,
      );
      assert.equal(
        (
          await call('post', '/auth/biometric/registration/verify', {
            challengeToken: options.challengeToken,
            response: registration,
          })
        ).status,
        403,
      );
      const challenge = check(
        await call('post', '/auth/step-up/biometric/challenge', {
          action: 'beneficiary_add',
        }),
      );
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(1);
      const assertionData = Buffer.concat([
        createHash('sha256').update('localhost').digest(),
        Buffer.from([0x05]),
        counter,
      ]);
      const assertionClient = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: challenge.options.challenge,
          origin: 'http://localhost:8081',
          crossOrigin: false,
        }),
      );
      const signature = sign(
        'sha256',
        Buffer.concat([
          assertionData,
          createHash('sha256').update(assertionClient).digest(),
        ]),
        keyPair.privateKey,
      );
      const assertion = {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: assertionClient.toString('base64url'),
          authenticatorData: assertionData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      };
      const proof = check(
        await call('post', '/auth/step-up/biometric', {
          challengeToken: challenge.challengeToken,
          response: assertion,
        }),
      );
      assert.equal('accessToken' in proof, false);
      check(
        await call('post', '/beneficiaries', {
          name: 'Biometric payee',
          bank: 'Demo',
          accountNumber: '12345678',
          stepUpToken: proof.stepUpToken,
        }),
        201,
      );
      assert.equal(
        (
          await call('post', '/auth/step-up/biometric', {
            challengeToken: challenge.challengeToken,
            response: assertion,
          })
        ).status,
        403,
      );
      check(
        await call(
          'delete',
          '/security/biometric-credentials/' + credentialId,
          { stepUpToken: await step('security_downgrade') },
        ),
      );
      assert.equal(
        check(await call('get', '/security')).biometricsEnabled,
        false,
      );
    },
  );
});
