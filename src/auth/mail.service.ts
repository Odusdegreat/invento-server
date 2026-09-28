import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile } from 'node:fs/promises';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async sendPasswordReset(to: string, token: string, messageId: string) {
    return this.sendToken(to, token, messageId, 'password-reset');
  }
  async sendEmailVerification(to: string, token: string, messageId: string) {
    return this.sendToken(to, token, messageId, 'email-verification');
  }
  private async sendToken(
    to: string,
    token: string,
    messageId: string,
    purpose: 'password-reset' | 'email-verification',
  ) {
    const key = this.config.get<string>('RESEND_API_KEY');
    const environment = this.config.get<string>('NODE_ENV');
    if (environment === 'test' || (!key && environment !== 'production')) {
      await mkdir('.tmp/mail', { recursive: true });
      await writeFile(
        `.tmp/mail/${messageId}.json`,
        JSON.stringify({ to, token, purpose, expiresIn: 900 }),
        { mode: 0o600 },
      );
      return;
    }
    const from = this.config.get<string>('RESEND_FROM_EMAIL');
    if (!key || !from) throw new Error('Email delivery is not configured');
    const resetUrl = this.config.get<string>(
      purpose === 'password-reset'
        ? 'PASSWORD_RESET_URL'
        : 'EMAIL_VERIFICATION_URL',
    );
    let instruction =
      purpose === 'password-reset'
        ? `Your single-use password reset token is:\n\n${token}`
        : `Verify your Invento email with this single-use token:\n\n${token}`;
    if (resetUrl) {
      const link = new URL(resetUrl);
      link.searchParams.set('token', token);
      instruction = `${purpose === 'password-reset' ? 'Reset your password' : 'Verify your email'} using this link:\n\n${link.toString()}`;
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `${purpose}/${messageId}`,
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject:
          purpose === 'password-reset'
            ? 'Reset your Invento password'
            : 'Verify your Invento email',
        text: `${instruction}\n\nThis expires in 15 minutes and can only be used once. If you did not request this, ignore this email.`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      // Never log provider bodies: they may contain addresses or message content.
      this.logger.error(
        `Password reset delivery rejected (HTTP ${response.status})`,
      );
      throw new Error('Email delivery failed');
    }
  }
}
