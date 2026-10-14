import {
  Inject,
  Injectable,
  SetMetadata,
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ApiHeader } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { fail } from './api-error.js';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT = 'rateLimit';

// A route rule replaces the global allowance for that route rather than adding
// to it, so a quote endpoint is limited to exactly the number it declares.
export const RateLimit = (limit: number, windowMs = 60_000) =>
  applyDecorators(
    SetMetadata(RATE_LIMIT, { limit, windowMs } as RateLimitRule),
    ApiHeader({ name: 'X-RateLimit-Limit', required: false }),
  );

@Injectable()
export class RateLimiter {
  private buckets = new Map<string, { count: number; expires: number }>();

  // Single-process limiter; a shared store is required before scaling out.
  hit(
    key: string,
    rule: RateLimitRule,
  ): { allowed: boolean; remaining: number } {
    const now = Date.now();
    for (const [k, v] of this.buckets)
      if (v.expires < now) this.buckets.delete(k);
    const bucket = this.buckets.get(key) ?? {
      count: 0,
      expires: now + rule.windowMs,
    };
    bucket.count++;
    this.buckets.set(key, bucket);
    return {
      allowed: bucket.count <= rule.limit,
      remaining: Math.max(0, rule.limit - bucket.count),
    };
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RateLimiter) private limiter: RateLimiter,
    @Inject(Reflector) private reflector: Reflector,
    @Inject(ConfigService) private config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const declared = this.reflector.getAllAndOverride<RateLimitRule>(
      RATE_LIMIT,
      [context.getHandler(), context.getClass()],
    );
    const rule =
      declared ??
      ({
        limit: this.config.get<number>('RATE_LIMIT_PER_MINUTE') ?? 120,
        windowMs: 60_000,
      } as RateLimitRule);
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    // Each declared rule gets its own bucket, so a route limit never spends the
    // global allowance. Undeclared routes share one global bucket per client.
    const scope = declared
      ? `${context.getClass().name}.${context.getHandler().name}`
      : 'global';
    const outcome = this.limiter.hit(
      `${scope}:${request.ip ?? 'unknown'}`,
      rule,
    );
    http
      .getResponse<Response>()
      .setHeader('X-RateLimit-Remaining', outcome.remaining);
    if (!outcome.allowed)
      fail('rate_limited', 'Too many requests; try again shortly', 429);
    return true;
  }
}
