import { validateEnvironment } from './environment.js';
const valid = {
  DATABASE_URL: 'postgresql://test@127.0.0.1/test',
  JWT_SECRET: 'test-secret-that-is-longer-than-32-characters',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only',
  CORS_ORIGINS: 'http://localhost:8081',
};
describe('environment validation', () => {
  it('fails closed for secrets, wildcard CORS and non-TLS remote databases', () => {
    expect(() =>
      validateEnvironment({ ...valid, JWT_SECRET: 'short' }),
    ).toThrow('JWT_SECRET');
    expect(() => validateEnvironment({ ...valid, CORS_ORIGINS: '*' })).toThrow(
      'CORS_ORIGINS',
    );
    expect(() =>
      validateEnvironment({
        ...valid,
        DATABASE_URL: 'postgresql://test@remote.example/test',
      }),
    ).toThrow('TLS');
  });
  it('normalizes the port and accepts the local configuration', () =>
    expect(validateEnvironment(valid).PORT).toBe(3000));
});
