import 'reflect-metadata';
import { mkdir, writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';

// Build route metadata without real credentials, database calls, or a listener.
Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://docs@127.0.0.1:5432/docs',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'documentation-only-placeholder',
  JWT_SECRET: 'documentation-only-placeholder-at-least-32-characters',
  CORS_ORIGINS: '',
});
const { AppModule } = await import('../dist/app.module.js');
const { createApiDocument } = await import('../dist/common/setup-application.js');
const app = await NestFactory.create(AppModule, { logger: false });
try {
  const document = createApiDocument(app);
  const directory = new URL('../docs/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('openapi.json', directory), JSON.stringify(document, null, 2) + '\n');
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
  const count = Object.values(document.paths).reduce(
    (total, path) => total + Object.keys(path).filter(method => methods.has(method)).length, 0,
  );
  console.log(`Exported ${count} operations to docs/openapi.json`);
} finally {
  await app.close();
}
