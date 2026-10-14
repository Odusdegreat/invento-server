import type postgres from 'postgres';
import type { Tx } from '../database/database.service.js';
import { fail } from './api-error.js';
import { digest } from './hash.js';

const keyPattern = /^[a-zA-Z0-9_-]{8,128}$/;

export function requireIdempotencyKey(key?: string): string {
  if (!key || !keyPattern.test(key))
    fail(
      'validation_error',
      'An Idempotency-Key of 8 to 128 letters, digits, hyphens or underscores is required',
    );
  return key;
}

// Object key order is part of the hash, so callers pass a literal whose keys
// are already in a stable order. Reusing a key with a different body is a
// conflict rather than a silent replay of the first result.
export function idempotencyHash(
  action: string,
  payload: Record<string, unknown>,
): string {
  return digest(JSON.stringify({ action, ...payload }));
}

export async function replayIdempotent<T = any>(
  tx: Tx,
  userId: string,
  key: string,
  requestHash: string,
): Promise<T | undefined> {
  const [cached] =
    await tx`select "requestHash",response from idempotency_keys where "userId"=${userId} and key=${key}`;
  if (!cached) return undefined;
  if (cached.requestHash !== requestHash)
    fail(
      'conflict',
      'This idempotency key was used for a different request',
      409,
    );
  return cached.response as T;
}

export async function recordIdempotent(
  tx: Tx,
  userId: string,
  key: string,
  requestHash: string,
  response: postgres.JSONValue,
): Promise<void> {
  await tx`insert into idempotency_keys("userId",key,"requestHash",response) values (${userId},${key},${requestHash},${tx.json(response)})`;
}
