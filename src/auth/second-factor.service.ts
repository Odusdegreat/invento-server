import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { fail } from '../common/api-error.js';

@Injectable()
export class SecondFactorService {
  constructor(@Inject(ConfigService) private config: ConfigService) {}
  private key() {
    const key = this.config.get<string>('MFA_ENCRYPTION_KEY') ?? '';
    if (!/^[a-fA-F0-9]{64}$/.test(key))
      fail(
        'service_unavailable',
        'Authenticator enrollment is not configured',
        503,
      );
    return Buffer.from(key, 'hex');
  }
  encrypt(secret: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from('invento-totp-v1'));
    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      'base64url',
    );
  }
  decrypt(value: string) {
    const data = Buffer.from(value, 'base64url'),
      decipher = createDecipheriv(
        'aes-256-gcm',
        this.key(),
        data.subarray(0, 12),
      );
    decipher.setAAD(Buffer.from('invento-totp-v1'));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString('utf8');
  }
  generate(email: string) {
    const secret = new Secret({ size: 20 });
    const totp = this.totp(secret.base32, email);
    return { secret: secret.base32, otpauthUrl: totp.toString() };
  }
  private totp(secret: string, label = 'Invento') {
    return new TOTP({
      issuer: 'Invento',
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    });
  }
  counter(encrypted: string, code: string, lastCounter: number) {
    const totp = this.totp(this.decrypt(encrypted));
    const now = Date.now(),
      delta = totp.validate({ token: code, window: 1, timestamp: now });
    if (delta === null) return null;
    const counter = Math.floor(now / 30000) + delta;
    return counter > lastCounter ? counter : null;
  }
}
