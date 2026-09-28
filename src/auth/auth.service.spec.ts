import { verify } from 'argon2';
import {
  AuthService,
  passwordHash,
  strongPassword,
  userView,
} from './auth.service.js';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../database/database.service.js';
import { MailService } from './mail.service.js';
import { SecondFactorService } from './second-factor.service.js';
describe('authentication secrets', () => {
  it('uses salted Argon2id hashes and rejects the wrong password', async () => {
    const first = await passwordHash('correct-password'),
      second = await passwordHash('correct-password');
    expect(first).toMatch(/^\$argon2id\$/);
    expect(first).not.toBe(second);
    expect(await verify(first, 'correct-password')).toBe(true);
    expect(await verify(first, 'wrong-password')).toBe(false);
  });
  it('rejects weak passwords and never serializes secret fields', () => {
    expect(() => strongPassword('short')).toThrow();
    const view = userView({
      id: 'user',
      passwordHash: 'secret',
      pinHash: 'secret',
      loginAttempts: 4,
    });
    expect(view).not.toHaveProperty('passwordHash');
    expect(view).not.toHaveProperty('pinHash');
    expect(view).not.toHaveProperty('loginAttempts');
  });
});

describe('password reset delivery privacy', () => {
  it.each([true, false])(
    'returns the same result on provider outage (account exists: %s)',
    async (exists) => {
      let committed = false;
      const tx = vi
        .fn()
        .mockResolvedValueOnce(exists ? [{ id: 'user-id' }] : [])
        .mockResolvedValue([]);
      const db = {
        sql: {
          begin: async (callback: (query: unknown) => Promise<unknown>) => {
            const result = await callback(tx);
            committed = true;
            return result;
          },
        },
      };
      const sendPasswordReset = vi.fn(async () => {
        expect(committed).toBe(true);
        throw new Error('provider unavailable');
      });
      const service = new AuthService(
        db as unknown as DatabaseService,
        new JwtService(),
        new ConfigService(),
        { sendPasswordReset } as unknown as MailService,
        new SecondFactorService(new ConfigService()),
      );
      expect(await service.requestReset('customer@example.com')).toEqual({
        sent: true,
      });
      expect(sendPasswordReset).toHaveBeenCalledTimes(exists ? 1 : 0);
    },
  );
});
