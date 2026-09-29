import {
  Inject,
  Injectable,
  SetMetadata,
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type Session } from './auth.service.js';
import { fail } from '../common/api-error.js';
import { ApiOperation } from '@nestjs/swagger';
export type AuthRequest = Request & { session: Session };
export const Public = () =>
  applyDecorators(SetMetadata('public', true), ApiOperation({ security: [] }));
@Injectable()
export class SessionGuard implements CanActivate {
  private buckets = new Map<string, { count: number; expires: number }>();
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(Reflector) private reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    // Single-process prototype limiter; use a shared limiter before horizontal scaling.
    const key = request.ip ?? 'unknown',
      now = Date.now();
    for (const [k, v] of this.buckets)
      if (v.expires < now) this.buckets.delete(k);
    const bucket = this.buckets.get(key) ?? { count: 0, expires: now + 60000 };
    bucket.count++;
    this.buckets.set(key, bucket);
    if (bucket.count > 120)
      fail('rate_limited', 'Too many requests; try again shortly', 429);
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
    if (!match) fail('unauthorized', 'Sign in to continue', 401);
    request.session = await this.auth.session(match[1]);
    return true;
  }
}
