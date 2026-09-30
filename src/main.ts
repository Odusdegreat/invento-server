import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { setupApplication } from './common/setup-application.js';
const app = await NestFactory.create(AppModule, { rawBody: true });
setupApplication(app);
await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'), '0.0.0.0');
