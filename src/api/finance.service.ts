import { Inject, Injectable } from '@nestjs/common';
import { v7 as id } from 'uuid';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { AuthService, digest, type Session } from '../auth/auth.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { fail } from '../common/api-error.js';
import { fee, minor, money } from '../common/money.js';
import type { QuoteDto, TransferDto, OrderDto } from './dto.js';
export function numericRows<T>(value: T): T {
  const fields = new Set([
    'amount',
    'fee',
    'price',
    'previousClose',
    'yieldPercent',
    'units',
    'averageCost',
    'total',
    'interestRate',
    'balance',
    'inflow',
    'outflow',
    'net',
    'value',
  ]);
  function walk(v: unknown): unknown {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          fields.has(k) && typeof x === 'string' ? Number(x) : walk(x),
        ]),
      );
    return v;
  }
  return walk(value) as T;
}
@Injectable()
export class FinanceService {
  constructor(
    @Inject(DatabaseService) private db: DatabaseService,
    @Inject(AuthService) private auth: AuthService,
    @Inject(LedgerService) private ledger: LedgerService,
  ) {}
  async account(tx: Tx, s: Session, accountId: string) {
    const [account] =
      await tx`select a.*,l.id as "ledgerId" from accounts a join ledger_accounts l on l."accountId"=a.id where a.id=${accountId} and a."userId"=${s.userId} for update of a`;
    if (!account) fail('not_found', 'Account not found', 404);
    if (account.frozen) fail('account_frozen', 'This account is frozen', 403);
    if (account.currency !== 'USD')
      fail(
        'unsupported_currency',
        'The prototype currently supports USD transactions only',
      );
    return account;
  }
  async quote(s: Session, dto: QuoteDto) {
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const account = await this.account(tx, s, dto.fromAccountId);
      const amount = minor(dto.amount),
        charge = fee(amount, 'transfer'),
        balance = await this.ledger.balance(tx, dto.fromAccountId);
      return {
        amount: money(amount),
        fee: money(charge),
        total: money(amount + charge),
        currency: account.currency,
        sufficientFunds: balance >= amount + charge,
      };
    });
  }
  async send(s: Session, dto: TransferDto, key: string | undefined) {
    if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
      fail(
        'validation_error',
        'An Idempotency-Key of 8 to 128 letters, digits, hyphens or underscores is required',
      );
    const amount = minor(dto.amount),
      charge = fee(amount, 'transfer');
    const requestHash = digest(
      JSON.stringify({
        action: 'transfer',
        fromAccountId: dto.fromAccountId,
        beneficiaryId: dto.beneficiaryId,
        amount: dto.amount,
        note: dto.note ?? '',
      }),
    );
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const [cached] =
        await tx`select * from idempotency_keys where "userId"=${s.userId} and key=${key}`;
      if (cached) {
        if (cached.requestHash !== requestHash)
          fail(
            'conflict',
            'This idempotency key was used for a different request',
            409,
          );
        return cached.response;
      }
      const account = await this.account(tx, s, dto.fromAccountId);
      const [beneficiary] =
        await tx`select * from beneficiaries where id=${dto.beneficiaryId} and "userId"=${s.userId} and "deletedAt" is null`;
      if (!beneficiary) fail('not_found', 'Beneficiary not found', 404);
      if ((await this.ledger.balance(tx, dto.fromAccountId)) < amount + charge)
        fail('insufficient_funds', 'Insufficient funds');
      await this.auth.consume(tx, s, 'transfer', dto.stepUpToken);
      const transferId = id(),
        transactionId = id(),
        reference = 'INV-' + id();
      const settlement = await this.ledger.system(
          tx,
          'settlement',
          account.currency as string,
        ),
        feeAccount = await this.ledger.system(
          tx,
          'fee',
          account.currency as string,
        );
      const journalId = await this.ledger.post(tx, reference, [
        {
          accountId: account.ledgerId as string,
          side: 'debit',
          amount: amount + charge,
        },
        { accountId: settlement, side: 'credit', amount },
        { accountId: feeAccount, side: 'credit', amount: charge },
      ]);
      await tx`insert into transactions(id,"userId","accountId","journalEntryId",amount,fee,currency,kind,category,description,counterparty,status,reference) values (${transactionId},${s.userId},${dto.fromAccountId},${journalId},${money(amount)},${money(charge)},${account.currency},'out','transfer',${dto.note ?? 'Simulated transfer'},${beneficiary.name},'completed',${reference})`;
      const [transfer] =
        await tx`insert into transfers(id,"userId","fromAccountId","beneficiaryId","transactionId",amount,fee,currency,note,reference) values (${transferId},${s.userId},${dto.fromAccountId},${dto.beneficiaryId},${transactionId},${money(amount)},${money(charge)},${account.currency},${dto.note ?? ''},${reference}) returning id,"fromAccountId","beneficiaryId","transactionId",amount,fee,currency,note,reference,status,"createdAt"`;
      const response = numericRows({
        ...transfer,
        total: money(amount + charge),
        counterparty: beneficiary.name,
      });
      await tx`insert into notifications(id,"userId",kind,title,body,"targetType","targetId") values (${id()},${s.userId},'transaction','Transfer complete','Your simulated transfer is complete.','transaction',${transactionId})`;
      await tx`insert into idempotency_keys("userId",key,"requestHash",response) values (${s.userId},${key},${requestHash},${tx.json(response)})`;
      return response;
    });
  }
  private async prepareOrder(tx: Tx, s: Session, dto: OrderDto) {
    const [product] =
      await tx`select * from investment_products where id=${dto.productId} and tradable=true for share`;
    if (!product) fail('not_found', 'Tradable product not found', 404);
    const [selected] = dto.fromAccountId
      ? [{ id: dto.fromAccountId }]
      : await tx`select id from accounts where "userId"=${s.userId} and currency=${product.currency} order by "createdAt",id limit 1`;
    if (!selected) fail('not_found', 'Funding account not found', 404);
    const account = await this.account(tx, s, selected.id as string);
    if (account.currency !== product.currency)
      fail('invalid_amount', 'Account and product currencies must match');
    // PostgreSQL decimal arithmetic determines gross and average cost.
    const [calculation] =
      await tx`select round(${dto.units}::numeric*${product.price}::numeric*100)::bigint as gross`;
    const gross = BigInt(calculation.gross),
      charge = fee(gross, dto.side);
    if (
      gross <= 0n ||
      gross > 100000000000n ||
      (dto.side === 'sell' && gross <= charge)
    )
      fail('invalid_amount', 'Order amount is outside supported limits');
    const [holding] =
      await tx`select * from holdings where "userId"=${s.userId} and "productId"=${dto.productId} for update`;
    if (dto.side === 'sell' && (!holding || Number(holding.units) < dto.units))
      fail('insufficient_funds', 'Insufficient units');
    if (
      dto.side === 'buy' &&
      (await this.ledger.balance(tx, account.id as string)) < gross + charge
    )
      fail('insufficient_funds', 'Insufficient funds');

    return { product, account, gross, charge, holding };
  }
  async orderQuote(s: Session, dto: OrderDto) {
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const { product, account, gross, charge } = await this.prepareOrder(
        tx,
        s,
        dto,
      );
      return {
        productId: product.id,
        fromAccountId: account.id,
        side: dto.side,
        units: dto.units,
        price: Number(product.price),
        fee: money(charge),
        total: money(dto.side === 'buy' ? gross + charge : gross - charge),
        currency: product.currency,
        pricedAt: product.pricedAt,
        simulated: true,
      };
    });
  }
  async order(s: Session, dto: OrderDto, key: string | undefined) {
    if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
      fail('validation_error', 'A valid Idempotency-Key is required');
    const requestHash = digest(
      JSON.stringify({
        action: 'order',
        productId: dto.productId,
        side: dto.side,
        units: dto.units,
        fromAccountId: dto.fromAccountId ?? null,
      }),
    );
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const [cached] =
        await tx`select * from idempotency_keys where "userId"=${s.userId} and key=${key}`;
      if (cached) {
        if (cached.requestHash !== requestHash)
          fail('conflict', 'Idempotency key already used', 409);
        return cached.response;
      }
      const { product, account, gross, charge, holding } =
        await this.prepareOrder(tx, s, dto);
      await this.auth.consume(tx, s, 'investment_order', dto.stepUpToken);
      const settlement = await this.ledger.system(
          tx,
          'investment',
          account.currency as string,
        ),
        feeAccount = await this.ledger.system(
          tx,
          'fee',
          account.currency as string,
        ),
        reference = 'INV-' + id();
      const entries =
        dto.side === 'buy'
          ? [
              {
                accountId: account.ledgerId as string,
                side: 'debit' as const,
                amount: gross + charge,
              },
              { accountId: settlement, side: 'credit' as const, amount: gross },
              {
                accountId: feeAccount,
                side: 'credit' as const,
                amount: charge,
              },
            ]
          : [
              { accountId: settlement, side: 'debit' as const, amount: gross },
              {
                accountId: account.ledgerId as string,
                side: 'credit' as const,
                amount: gross - charge,
              },
              {
                accountId: feeAccount,
                side: 'credit' as const,
                amount: charge,
              },
            ];
      const journalId = await this.ledger.post(tx, reference, entries);
      if (dto.side === 'buy')
        await tx`insert into holdings(id,"userId","productId",units,"averageCost") values (${id()},${s.userId},${dto.productId},${dto.units},${product.price}) on conflict("userId","productId") do update set "averageCost"=(holdings.units*holdings."averageCost"+excluded.units*excluded."averageCost")/(holdings.units+excluded.units),units=holdings.units+excluded.units`;
      else
        await tx`update holdings set units=units-${dto.units}::numeric where "userId"=${s.userId} and "productId"=${dto.productId}`;
      const total = money(dto.side === 'buy' ? gross + charge : gross - charge),
        orderId = id(),
        transactionId = id();
      const [order] =
        await tx`insert into investment_orders(id,"userId","productId","accountId","journalEntryId",side,units,price,total,fee,status) values (${orderId},${s.userId},${dto.productId},${account.id},${journalId},${dto.side},${dto.units},${product.price},${total},${money(charge)},'filled') returning id,"productId",side,units,price,total,fee,status,"createdAt"`;
      if (dto.side === 'sell')
        await tx`update investment_orders set "realizedGain"=${total}::numeric-${dto.units}::numeric*${holding.averageCost}::numeric where id=${orderId}`;
      await tx`insert into transactions(id,"userId","accountId","journalEntryId",amount,fee,currency,kind,category,description,counterparty,status,reference) values (${transactionId},${s.userId},${account.id},${journalId},${money(gross)},${money(charge)},${account.currency},${dto.side === 'buy' ? 'out' : 'in'},'investment',${dto.side + ' ' + String(product.name)},${product.provider},'completed',${reference})`;
      await tx`insert into notifications(id,"userId",kind,title,body,"targetType","targetId") values (${id()},${s.userId},'investment','Order filled','Your simulated order has been filled.','investment',${orderId})`;
      const response = numericRows(order);
      await tx`insert into idempotency_keys("userId",key,"requestHash",response) values (${s.userId},${key},${requestHash},${tx.json(response)})`;
      return response;
    });
  }
}
