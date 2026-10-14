// postgres.js hands back Date objects for timestamptz and, since the driver is
// configured to parse numeric as a number, plain numbers for money. The wire
// contract is ISO-8601 UTC so the client formats it locally.
export function jsonRows<T>(value: T): T {
  function walk(v: unknown): unknown {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, walk(x)]),
      );
    return v;
  }
  return walk(value) as T;
}
