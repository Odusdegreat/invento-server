import { fail } from './api-error.js';
export function minor(value: number): bigint {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 1_000_000_000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 0.00001
  )
    fail(
      'invalid_amount',
      'Use a positive amount with at most two decimal places',
    );
  return BigInt(Math.round(value * 100));
}
export function money(value: bigint): number {
  return Number(value) / 100;
}
export function fee(amount: bigint, side: 'transfer' | 'buy' | 'sell'): bigint {
  const rate = side === 'sell' ? 50n : 75n;
  const rounded = (amount * rate + 5000n) / 10000n;
  const floor = rounded < 100n ? 100n : rounded;
  return side === 'transfer' && floor > 1800n ? 1800n : floor;
}
