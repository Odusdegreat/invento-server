import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service.js';

describe('Resend password-reset delivery', () => {
  afterEach(() => vi.unstubAllGlobals());
  const config = (extra = {}) =>
    new ConfigService({
      NODE_ENV: 'production',
      RESEND_API_KEY: 'test-key',
      RESEND_FROM_EMAIL: 'Invento <noreply@example.com>',
      ...extra,
    });
  it('sends the configured reset link, expiry and idempotency header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await new MailService(
      config({ PASSWORD_RESET_URL: 'https://example.com/reset?source=app' }),
    ).sendPasswordReset('customer@example.com', 'one-time-token', 'message-id');
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(request.headers).toMatchObject({
      'Idempotency-Key': 'password-reset/message-id',
      Authorization: 'Bearer test-key',
    });
    const body = JSON.parse(request.body as string);
    expect(body.to).toEqual(['customer@example.com']);
    expect(body.text).toContain(
      'https://example.com/reset?source=app&token=one-time-token',
    );
    expect(body.text).toContain('15 minutes');
  });
  it('includes a token when no reset screen is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await new MailService(config()).sendPasswordReset(
      'customer@example.com',
      'token',
      'message-id',
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain(
      'reset token is:\n\ntoken',
    );
  });
  it('fails safely on a provider rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );
    await expect(
      new MailService(config()).sendPasswordReset(
        'customer@example.com',
        'token',
        'message-id',
      ),
    ).rejects.toThrow('Email delivery failed');
  });
  it('never falls back to writing reset tokens to disk in production', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      new MailService(
        new ConfigService({ NODE_ENV: 'production' }),
      ).sendPasswordReset('customer@example.com', 'token', 'message-id'),
    ).rejects.toThrow('Email delivery is not configured');
    expect(fetch).not.toHaveBeenCalled();
  });
});
