import { ConfigService } from '@nestjs/config';
import { TOTP, Secret } from 'otpauth';
import { SecondFactorService } from './second-factor.service.js';
describe('authenticator cryptography', () => {
  const service = new SecondFactorService(
    new ConfigService({ MFA_ENCRYPTION_KEY: 'ab'.repeat(32) }),
  );
  it('encrypts secrets with randomized authenticated encryption and detects tampering', () => {
    const one = service.encrypt('secret'),
      two = service.encrypt('secret');
    expect(one).not.toBe(two);
    expect(service.decrypt(one)).toBe('secret');
    const corrupt = Buffer.from(one, 'base64url');
    corrupt[15] ^= 1;
    expect(() => service.decrypt(corrupt.toString('base64url'))).toThrow();
  });
  it('verifies authenticator codes and rejects reused counters', () => {
    const generated = service.generate('test@example.com');
    const totp = new TOTP({
      secret: Secret.fromBase32(generated.secret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    const encrypted = service.encrypt(generated.secret),
      counter = service.counter(encrypted, totp.generate(), -1);
    expect(counter).not.toBeNull();
    expect(service.counter(encrypted, totp.generate(), counter!)).toBeNull();
  });
});
