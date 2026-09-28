import { isEmail } from 'class-validator';

export function validateEnvironment(input: Record<string, unknown>) {
  const read = (name: string, fallback = '') => {
    const value = input[name] ?? fallback;
    if (typeof value !== 'string') throw new Error(name + ' must be a string');
    return value;
  };
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(read('DATABASE_URL'));
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol))
    throw new Error('DATABASE_URL must use PostgreSQL');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) &&
    !['require', 'verify-full', 'verify-ca'].includes(
      databaseUrl.searchParams.get('sslmode') ?? '',
    )
  )
    throw new Error(
      'Remote DATABASE_URL requires sslmode=require or verified TLS',
    );
  const jwtSecret = read('JWT_SECRET');
  if (jwtSecret.length < 32 || jwtSecret.startsWith('replace-'))
    throw new Error(
      'JWT_SECRET must be a random secret of at least 32 characters',
    );
  const environment = read('NODE_ENV', 'development');
  if (!['development', 'test', 'production'].includes(environment))
    throw new Error('NODE_ENV must be development, test, or production');
  const resendKey = read('RESEND_API_KEY').trim();
  const resendFrom = read('RESEND_FROM_EMAIL').trim();
  if (environment !== 'test' && (resendKey || environment === 'production')) {
    const address = /<([^<>]+)>$/.exec(resendFrom)?.[1] ?? resendFrom;
    if (!resendKey || !isEmail(address) || /[\r\n]/.test(resendFrom))
      throw new Error(
        'Resend requires RESEND_API_KEY and a valid RESEND_FROM_EMAIL',
      );
  }
  const encryptionKey = read('MFA_ENCRYPTION_KEY').trim();
  if (encryptionKey && !/^[a-fA-F0-9]{64}$/.test(encryptionKey))
    throw new Error(
      'MFA_ENCRYPTION_KEY must contain 64 hexadecimal characters',
    );
  const rpId = read('WEBAUTHN_RP_ID').trim(),
    webauthnOrigin = read('WEBAUTHN_ORIGIN').trim();
  if (rpId || webauthnOrigin) {
    let valid = false;
    try {
      const origin = new URL(webauthnOrigin);
      valid =
        origin.origin === webauthnOrigin &&
        (origin.hostname === rpId || origin.hostname.endsWith('.' + rpId)) &&
        (origin.protocol === 'https:' ||
          (environment !== 'production' &&
            origin.protocol === 'http:' &&
            origin.hostname === 'localhost'));
    } catch {
      /* Invalid origin. */
    }
    if (!valid)
      throw new Error(
        'WEBAUTHN_ORIGIN must be a trusted HTTPS origin matching WEBAUTHN_RP_ID (localhost HTTP is allowed in development)',
      );
  }
  for (const name of ['PASSWORD_RESET_URL', 'EMAIL_VERIFICATION_URL']) {
    const resetUrl = read(name).trim();
    if (resetUrl) {
      let valid = false;
      try {
        const link = new URL(resetUrl);
        valid =
          !link.username &&
          !link.password &&
          (['https:', 'invento:', 'inveto:'].includes(link.protocol) ||
            (link.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(link.hostname)));
      } catch {
        /* Invalid link. */
      }
      if (!valid)
        throw new Error(
          `${name} must use HTTPS, a local HTTP URL, or the invento/inveto app scheme`,
        );
    }
  }
  const port = Number(input.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer between 1 and 65535');
  const url = read('SUPABASE_URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL');
  }
  if (
    parsed.username ||
    parsed.password ||
    !['https:', 'http:'].includes(parsed.protocol) ||
    (parsed.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
  )
    throw new Error('SUPABASE_URL requires HTTPS except for local development');
  const key = read('SUPABASE_SERVICE_ROLE_KEY').trim();
  if (!key || key.startsWith('replace-'))
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY must be configured on the server',
    );
  const origins = read('CORS_ORIGINS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let valid = false;
    try {
      const value = new URL(origin);
      valid =
        ['http:', 'https:'].includes(value.protocol) && value.origin === origin;
    } catch {
      /* Invalid origin. */
    }
    if (!valid)
      throw new Error('CORS_ORIGINS must contain explicit HTTP(S) origins');
  }
  return {
    ...input,
    NODE_ENV: environment,
    PORT: port,
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: key,
    CORS_ORIGINS: origins.join(','),
    RESEND_API_KEY: resendKey,
    RESEND_FROM_EMAIL: resendFrom,
    PASSWORD_RESET_URL: read('PASSWORD_RESET_URL').trim(),
    EMAIL_VERIFICATION_URL: read('EMAIL_VERIFICATION_URL').trim(),
    MFA_ENCRYPTION_KEY: encryptionKey,
    WEBAUTHN_RP_ID: rpId,
    WEBAUTHN_ORIGIN: webauthnOrigin,
  };
}
