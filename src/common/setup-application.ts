import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  Logger,
  ValidationPipe,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from './api-error.js';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const databaseConflict =
      exception !== null &&
      typeof exception === 'object' &&
      'code' in exception &&
      exception.code === '23505';
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : databaseConflict
          ? 409
          : 500;
    const codes: Record<number, string> = {
      400: 'validation_error',
      401: 'unauthorized',
      403: 'forbidden',
      404: 'not_found',
      409: 'conflict',
      429: 'rate_limited',
    };
    const error =
      exception instanceof ApiError && status < 500
        ? exception.getResponse()
        : {
            code:
              codes[status] ??
              (status >= 500 ? 'internal_error' : 'request_error'),
            message:
              status >= 500
                ? 'An internal error occurred'
                : 'The request could not be completed',
          };
    response
      .status(status)
      .json({ ...(error as object), requestId: response.locals.requestId });
  }
}
export function setupApplication(app: INestApplication) {
  const config = app.get(ConfigService);
  const logger = new Logger('HTTP');
  app.use((request: Request, response: Response, next: NextFunction) => {
    const start = performance.now();
    response.locals.requestId = randomUUID();
    response.setHeader('X-Request-Id', response.locals.requestId as string);
    response.setHeader('Cache-Control', 'no-store');
    response.on('finish', () =>
      logger.log(
        JSON.stringify({
          requestId: response.locals.requestId,
          method: request.method,
          route:
            (request.route as { path?: string } | undefined)?.path ??
            'unmatched',
          status: response.statusCode,
          durationMs: Math.round(performance.now() - start),
        }),
      ),
    );
    next();
  });
  app.enableCors({
    origin: config
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .filter(Boolean),
    exposedHeaders: ['X-Request-Id', 'X-Next-Cursor'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false, value: false },
      exceptionFactory: (errors) =>
        errors.some((e) => ['amount', 'units'].includes(e.property))
          ? new ApiError(
              400,
              'invalid_amount',
              'Amount or units are outside supported limits',
            )
          : new ApiError(
              400,
              'validation_error',
              'Request fields failed validation',
            ),
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  SwaggerModule.setup(
    'api/docs',
    app,
    createApiDocument(app),
  );
  app.enableShutdownHooks();
}

export function createApiDocument(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Invento prototype API')
      .setDescription('Simulated finance. No real financial rails.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
}
