import { fee, minor } from './money.js';
describe('server fee schedule', () => {
  it.each([
    [1, 100n],
    [100, 100n],
    [200, 150n],
    [2400, 1800n],
    [10000, 1800n],
  ])('transfer fee for %s', (amount, expected) =>
    expect(fee(minor(amount), 'transfer')).toBe(expected),
  );
  it('has uncapped investment fees with distinct buy and sell rates', () => {
    expect(fee(minor(10000), 'buy')).toBe(7500n);
    expect(fee(minor(10000), 'sell')).toBe(5000n);
  });
  it.each([0, -1, NaN, Infinity, 0.001, 1000000001])(
    'rejects invalid amount %s',
    (amount) => expect(() => minor(amount)).toThrow(),
  );
});
