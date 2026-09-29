import { Inject, Injectable } from '@nestjs/common';
import { v7 as id } from 'uuid';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { AuthService, userView, type Session } from '../auth/auth.service.js';
import { fail } from '../common/api-error.js';
import { numericRows } from './finance.service.js';
import type {
  UpdateProfileDto,
  BeneficiaryDto,
  CardDto,
  SecurityDto,
  CardPatchDto,
} from './dto.js';
import type { TransactionQueryDto, ProductsQueryDto } from './query.dto.js';
@Injectable()
export class ResourcesService {
  constructor(
    @Inject(DatabaseService) private db: DatabaseService,
    @Inject(AuthService) private auth: AuthService,
  ) {}
  async mutation<T>(s: Session, fn: (tx: Tx) => Promise<T>) {
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      return fn(tx);
    });
  }
  async user(s: Session) {
    const [row] = await this.db.sql`select * from users where id=${s.userId}`;
    return userView(row);
  }
  async updateUser(s: Session, dto: UpdateProfileDto) {
    return this.mutation(s, async (tx) => {
      const fields = Object.fromEntries(
        Object.entries(dto).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(fields).length === 0) return this.user(s);
      if (dto.email) {
        dto.email = dto.email.toLowerCase();
        const [existing] =
          await tx`select id from users where email=${dto.email} and id<>${s.userId}`;
        if (existing)
          fail('conflict', 'Unable to use these profile details', 409);
      }
      const patch = {
        ...fields,
        ...(dto.email ? { email: dto.email, emailVerified: false } : {}),
      };
      const [row] =
        await tx`update users set ${tx(patch)} where id=${s.userId} returning *`;
      return userView(row);
    });
  }
  async accounts(s: Session, accountId?: string) {
    const rows = await this.db
      .sql`select a.id,a.name,a.kind,a.currency,a."maskedNumber",a."interestRate",a.frozen,a."createdAt",b."balanceMinor"::numeric/100 as balance from accounts a join account_balances b on b.id=a.id where a."userId"=${s.userId} ${accountId ? this.db.sql`and a.id=${accountId}` : this.db.sql``} order by a."createdAt",a.id`;
    if (accountId && !rows.length) fail('not_found', 'Account not found', 404);
    return numericRows(accountId ? rows[0] : rows);
  }
  async totals(s: Session) {
    const rows = await this.db
      .sql`select a.currency,sum(b."balanceMinor")::numeric/100 as balance from accounts a join account_balances b on b.id=a.id where a."userId"=${s.userId} group by a.currency`;
    return {
      totalBalance: Number(
        rows.find((r) => r.currency === 'USD')?.balance ?? 0,
      ),
      currency: 'USD',
      balances: numericRows(rows),
    };
  }
  async freezeAccount(s: Session, accountId: string, frozen: boolean) {
    return this.mutation(s, async (tx) => {
      const [row] =
        await tx`update accounts set frozen=${frozen} where id=${accountId} and "userId"=${s.userId} returning id`;
      if (!row) fail('not_found', 'Account not found', 404);
      return { ok: true, frozen };
    });
  }
  async transactions(s: Session, query: TransactionQueryDto) {
    if (query.accountId) await this.accounts(s, query.accountId);
    this.validateTransactionQuery(query);
    const sql = this.db.sql;
    const rows =
      await sql`select id,"accountId",amount,fee,currency,kind,category,description,counterparty,"cardLast4",status,reference,"createdAt" from transactions where "userId"=${s.userId}
   ${query.accountId ? sql`and "accountId"=${query.accountId}` : sql``}
   ${query.category ? sql`and category=${query.category}` : sql``}
   ${query.kind || query.type ? sql`and kind=${query.kind ?? query.type!}` : sql``}
   ${query.from ? sql`and "createdAt">=${query.from}::timestamptz` : sql``}
   ${query.to ? sql`and "createdAt"<${query.to}::timestamptz` : sql``}
   ${query.before ? sql`and id<${query.before}` : sql``}
   order by id desc limit ${query.limit}`;
    return numericRows(rows);
  }
  validateTransactionQuery(query: TransactionQueryDto) {
    if (query.kind && query.type && query.kind !== query.type)
      fail('validation_error', 'kind and type must agree');
    if (
      query.from &&
      query.to &&
      Date.parse(query.from) >= Date.parse(query.to)
    )
      fail('validation_error', 'from must be earlier than to');
  }
  async transactionTotals(
    s: Session,
    query: TransactionQueryDto = { limit: 50 },
  ) {
    this.validateTransactionQuery(query);
    if (query.accountId) await this.accounts(s, query.accountId);
    const sql = this.db.sql;
    return numericRows(
      await this.db.sql`select currency,
      coalesce(sum(case when kind='in' then amount-fee else 0 end),0) as inflow,
      coalesce(sum(case when kind='out' then amount+fee else 0 end),0) as outflow
      from transactions where "userId"=${s.userId} and status='completed'
      ${query.accountId ? sql`and "accountId"=${query.accountId}` : sql``}
      ${query.category ? sql`and category=${query.category}` : sql``}
      ${query.kind || query.type ? sql`and kind=${query.kind ?? query.type!}` : sql``}
      ${query.from ? sql`and "createdAt">=${query.from}::timestamptz` : sql``}
      ${query.to ? sql`and "createdAt"<${query.to}::timestamptz` : sql``}
      group by currency`,
    );
  }
  async transaction(s: Session, transactionId: string) {
    const [row] = await this.db
      .sql`select id,"accountId",amount,fee,currency,kind,category,description,counterparty,"cardLast4",status,reference,"createdAt" from transactions where id=${transactionId} and "userId"=${s.userId}`;
    if (!row) fail('not_found', 'Transaction not found', 404);
    return numericRows(row);
  }
  async transfer(s: Session, transferId: string) {
    const [row] = await this.db
      .sql`select t.id,t."fromAccountId",t."beneficiaryId",t."recipientAccountId",t."transactionId",t.amount,t.fee,t.amount+t.fee as total,case when t.status='failed' then 0 else t.amount+t.fee end as "debitedAmount",true as simulated,t.currency,t.note,t.reference,t.status,t."createdAt",x.counterparty from transfers t join transactions x on x.id=t."transactionId" where t.id=${transferId} and t."userId"=${s.userId}`;
    if (!row) fail('not_found', 'Transfer not found', 404);
    return numericRows(row);
  }
  async beneficiaries(s: Session) {
    return this.db
      .sql`select id,name,bank,"accountNumber","createdAt" from beneficiaries where "userId"=${s.userId} and "deletedAt" is null order by "createdAt",id`;
  }
  async addBeneficiary(s: Session, dto: BeneficiaryDto) {
    return this.mutation(s, async (tx) => {
      await this.auth.consume(tx, s, 'beneficiary_add', dto.stepUpToken);
      const [row] =
        await tx`insert into beneficiaries(id,"userId",name,bank,"accountNumber") values (${id()},${s.userId},${dto.name},${dto.bank},${dto.accountNumber}) returning id,name,bank,"accountNumber","createdAt"`;
      return row;
    });
  }
  async removeBeneficiary(s: Session, beneficiaryId: string) {
    return this.mutation(s, async (tx) => {
      const rows =
        await tx`update beneficiaries set "deletedAt"=now() where id=${beneficiaryId} and "userId"=${s.userId} and "deletedAt" is null returning id`;
      if (!rows.length) fail('not_found', 'Beneficiary not found', 404);
      return { ok: true };
    });
  }
  async cards(s: Session) {
    return this.db
      .sql`select id,brand,label,last4,expiry,holder,"isDefault",frozen from cards where "userId"=${s.userId} order by id`;
  }
  async addCard(s: Session, dto: CardDto) {
    return this.mutation(s, async (tx) => {
      const [user] =
        await tx`select "fullName" from users where id=${s.userId}`;
      const [count] =
        await tx`select count(*)::int as count from cards where "userId"=${s.userId}`;
      const [row] =
        await tx`insert into cards(id,"userId",brand,label,last4,expiry,holder,"isDefault") values (${id()},${s.userId},${dto.brand},${dto.label},${dto.last4},${dto.expiry},${dto.holder ?? user.fullName},${count.count === 0}) returning id,brand,label,last4,expiry,holder,"isDefault",frozen`;
      return row;
    });
  }
  async cardAction(
    s: Session,
    cardId: string,
    action: 'default' | 'freeze' | 'unfreeze' | 'delete',
  ) {
    return this.mutation(s, async (tx) => {
      const [card] =
        await tx`select id from cards where id=${cardId} and "userId"=${s.userId}`;
      if (!card) fail('not_found', 'Card not found', 404);
      if (action === 'delete') await tx`delete from cards where id=${cardId}`;
      else if (action === 'default') {
        await tx`update cards set "isDefault"=false where "userId"=${s.userId}`;
        await tx`update cards set "isDefault"=true where id=${cardId}`;
      } else
        await tx`update cards set frozen=${action === 'freeze'} where id=${cardId}`;
      return { ok: true };
    });
  }
  async freezeCards(s: Session, frozen: boolean) {
    return this.mutation(s, async (tx) => {
      await tx`update cards set frozen=${frozen} where "userId"=${s.userId}`;
      return { ok: true };
    });
  }
  async products(productId?: string, query: ProductsQueryDto = {}) {
    const sql = this.db.sql;
    const rows = await this.db
      .sql`select * from investment_products where true ${productId ? sql`and id=${productId}` : sql``}
      ${query.assetClass ? sql`and "assetClass"=${query.assetClass}` : sql``}
      ${query.search ? sql`and (strpos(lower(name),lower(${query.search}))>0 or strpos(lower(ticker),lower(${query.search}))>0)` : sql``} order by ticker`;
    if (productId && !rows.length) fail('not_found', 'Product not found', 404);
    return numericRows(productId ? rows[0] : rows);
  }
  async holdings(s: Session) {
    return numericRows(
      await this.db
        .sql`select id,"productId",units,"averageCost","addedAt" from holdings where "userId"=${s.userId} and units>0 order by id`,
    );
  }
  async orders(s: Session) {
    return numericRows(
      await this.db
        .sql`select id,"productId",side,units,price,total,fee,status,"createdAt" from investment_orders where "userId"=${s.userId} order by id desc limit 100`,
    );
  }
  async watchlist(s: Session) {
    return (
      await this.db
        .sql`select "productId" from watchlists where "userId"=${s.userId} order by "productId"`
    ).map((r) => r.productId as string);
  }
  async order(s: Session, orderId: string) {
    const [row] = await this.db
      .sql`select id,"productId",side,units,price,total,fee,status,"createdAt" from investment_orders where id=${orderId} and "userId"=${s.userId}`;
    if (!row) fail('not_found', 'Order not found', 404);
    return numericRows(row);
  }
  async updateCard(s: Session, cardId: string, dto: CardPatchDto) {
    return this.mutation(s, async (tx) => {
      const [card] =
        await tx`select id from cards where id=${cardId} and "userId"=${s.userId}`;
      if (!card) fail('not_found', 'Card not found', 404);
      const patch = Object.fromEntries(
        Object.entries(dto).filter(([, v]) => v !== undefined),
      );
      if (dto.isDefault === true)
        await tx`update cards set "isDefault"=false where "userId"=${s.userId}`;
      if (Object.keys(patch).length)
        await tx`update cards set ${tx(patch)} where id=${cardId}`;
      const [result] =
        await tx`select id,brand,label,last4,expiry,holder,"isDefault",frozen from cards where id=${cardId}`;
      return result;
    });
  }
  async accountSummary(s: Session, currency = 'USD') {
    const rows = await this.db
      .sql`select a.currency,sum(b."balanceMinor")::numeric/100 as balance,r."unitsPerUsd",r."asOf" from accounts a join account_balances b on b.id=a.id left join fx_rates r on r.currency=a.currency where a."userId"=${s.userId} group by a.currency,r."unitsPerUsd",r."asOf"`;
    const [target] = await this.db
      .sql`select "unitsPerUsd","asOf" from fx_rates where currency=${currency}`;
    if (!target || rows.some((r) => !r.unitsPerUsd))
      fail(
        'unsupported_currency',
        'No simulated display rate exists for this currency',
      );
    const convertedTotal =
      Math.round(
        rows.reduce(
          (sum, r) =>
            sum +
            (Number(r.balance) / Number(r.unitsPerUsd)) *
              Number(target.unitsPerUsd),
          0,
        ) * 100,
      ) / 100;
    return {
      currency,
      convertedTotal,
      balances: rows.map((r) => ({
        currency: r.currency,
        balance: Number(r.balance),
      })),
      simulated: true,
      ratesAsOf: target.asOf,
    };
  }
  async portfolio(s: Session) {
    const dashboard = await this.dashboard(s);
    return {
      currency: dashboard.currency,
      portfolioValue: dashboard.portfolioValue,
      allTimeGain: dashboard.allTimeGain,
      holdings: await this.holdings(s),
    };
  }
  async home(s: Session) {
    const [user, balances, portfolio, recentTransactions, unreadCount] =
      await Promise.all([
        this.user(s),
        this.totals(s),
        this.portfolio(s),
        this.transactions(s, { limit: 5 }),
        this.unread(s),
      ]);
    return { user, balances, portfolio, recentTransactions, unreadCount };
  }
  async watch(s: Session, productId: string, add: boolean) {
    return this.mutation(s, async (tx) => {
      const [product] =
        await tx`select id from investment_products where id=${productId}`;
      if (!product) fail('not_found', 'Product not found', 404);
      if (add)
        await tx`insert into watchlists("userId","productId") values (${s.userId},${productId}) on conflict do nothing`;
      else
        await tx`delete from watchlists where "userId"=${s.userId} and "productId"=${productId}`;
      return { ok: true };
    });
  }
  async notifications(s: Session, limit: number, before?: string) {
    return this.db
      .sql`select id,kind,title,body,"createdAt",read,"targetType","targetId" from notifications where "userId"=${s.userId} ${before ? this.db.sql`and id<${before}` : this.db.sql``} order by id desc limit ${limit}`;
  }
  async unread(s: Session) {
    const [row] = await this.db
      .sql`select count(*)::int as count from notifications where "userId"=${s.userId} and read=false`;
    return row.count as number;
  }
  async markRead(s: Session, notificationId?: string) {
    return this.mutation(s, async (tx) => {
      const rows =
        await tx`update notifications set read=true where "userId"=${s.userId} ${notificationId ? tx`and id=${notificationId}` : tx``} returning id`;
      if (notificationId && !rows.length)
        fail('not_found', 'Notification not found', 404);
      return { ok: true };
    });
  }
  async security(s: Session) {
    const [row] = await this.db
      .sql`select ("pinHash" is not null) as "pinSet","twoFactorEnabled","biometricsEnabled","autoLock","transactionAlerts","loginAlerts" from security_settings where "userId"=${s.userId}`;
    return row;
  }
  async updateSecurity(s: Session, dto: SecurityDto) {
    return this.mutation(s, async (tx) => {
      const [row] =
        await tx`select * from security_settings where "userId"=${s.userId}`;
      if (
        dto.twoFactorEnabled !== undefined &&
        dto.twoFactorEnabled !== row.twoFactorEnabled
      )
        fail(
          'mfa_enrollment_required',
          'Use the authenticator enrollment or disable flow',
          409,
        );
      if (dto.biometricsEnabled === true) {
        const [credential] =
          await tx`select id from biometric_credentials where "userId"=${s.userId} and "revokedAt" is null limit 1`;
        if (!credential)
          fail(
            'biometrics_disabled',
            'Enroll a verified device credential first',
            403,
          );
      }
      if (
        (row.twoFactorEnabled && dto.twoFactorEnabled === false) ||
        (row.biometricsEnabled && dto.biometricsEnabled === false)
      )
        await this.auth.consume(tx, s, 'security_downgrade', dto.stepUpToken);
      const patch = Object.fromEntries(
        Object.entries(dto).filter(
          ([key, value]) => key !== 'stepUpToken' && value !== undefined,
        ),
      );
      if (Object.keys(patch).length)
        await tx`update security_settings set ${tx(patch)} where "userId"=${s.userId}`;
      const [result] =
        await tx`select ("pinHash" is not null) as "pinSet","twoFactorEnabled","biometricsEnabled","autoLock","transactionAlerts","loginAlerts" from security_settings where "userId"=${s.userId}`;
      return result;
    });
  }
  async devices(s: Session) {
    return this.db
      .sql`select id,name,trusted,"createdAt","lastActiveAt",(id=${s.deviceId}) as current from devices where "userId"=${s.userId} and "revokedAt" is null order by "createdAt" desc`;
  }
  async revoke(s: Session, deviceId: string) {
    return this.mutation(s, async (tx) => {
      if (deviceId === s.deviceId)
        fail('conflict', 'Use logout to end the current session', 409);
      const rows =
        await tx`update devices set "revokedAt"=now() where id=${deviceId} and "userId"=${s.userId} and "revokedAt" is null returning id`;
      if (!rows.length) fail('not_found', 'Device not found', 404);
      await tx`update refresh_tokens set "revokedAt"=now() where "deviceId"=${deviceId}`;
      await tx`delete from push_tokens where "deviceId"=${deviceId}`;
      return { ok: true };
    });
  }
  async preferences(s: Session) {
    const [row] = await this.db
      .sql`select currency from preferences where "userId"=${s.userId}`;
    return row;
  }
  async preference(s: Session, currency: string) {
    return this.mutation(s, async (tx) => {
      const [row] =
        await tx`update preferences set currency=${currency} where "userId"=${s.userId} returning currency`;
      return row;
    });
  }
  async dispute(s: Session, transactionId: string, reason: string) {
    return this.mutation(s, async (tx) => {
      const [transaction] =
        await tx`select id from transactions where id=${transactionId} and "userId"=${s.userId}`;
      if (!transaction) fail('not_found', 'Transaction not found', 404);
      const [row] =
        await tx`insert into disputes(id,"userId","transactionId",reason) values (${id()},${s.userId},${transactionId},${reason}) on conflict("userId","transactionId") do nothing returning id,"transactionId",reason,status,"createdAt"`;
      if (!row)
        fail('conflict', 'A dispute already exists for this transaction', 409);
      return row;
    });
  }
  async dashboard(s: Session) {
    // A single snapshot prevents mixed balances during concurrent transfers.
    return this.db.sql.begin(
      'isolation level repeatable read read only',
      async (tx) => {
        const [cash] =
          await tx`select coalesce(sum(b."balanceMinor"),0)::numeric/100 as total from accounts a join account_balances b on b.id=a.id where a."userId"=${s.userId} and a.currency='USD'`;
        const [portfolio] =
          await tx`select coalesce(sum(h.units*p.price),0) as value,coalesce(sum(h.units*(p.price-h."averageCost")),0) as gain from holdings h join investment_products p on p.id=h."productId" where h."userId"=${s.userId} and p.currency='USD'`;
        const [realized] =
          await tx`select coalesce(sum(o."realizedGain"-case when o.side='buy' then o.fee else 0 end),0) as gain from investment_orders o join investment_products p on p.id=o."productId" where o."userId"=${s.userId} and p.currency='USD'`;
        const rows =
          await tx`select kind,category,amount,fee,"createdAt" from transactions where "userId"=${s.userId} and currency='USD' and status='completed' and "createdAt">=least(date_trunc('month',now() at time zone 'UTC') at time zone 'UTC',(date_trunc('day',now() at time zone 'UTC')-interval '6 days') at time zone 'UTC')`;
        const today = new Date().toISOString().slice(0, 10),
          month = today.slice(0, 7);
        const days = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(today + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() - 6 + i);
          return { date: d.toISOString().slice(0, 10), netMinor: 0 };
        });
        let inflow = 0,
          outflow = 0;
        const spending: Record<string, number> = {};
        for (const r of rows) {
          const amount = Math.round(Number(r.amount) * 100),
            charge = Math.round(Number(r.fee) * 100);
          const signed = r.kind === 'in' ? amount - charge : -(amount + charge),
            date = new Date(r.createdAt).toISOString().slice(0, 10);
          const day = days.find((d) => d.date === date);
          if (day) day.netMinor += signed;
          if (date.startsWith(month)) {
            if (signed > 0) inflow += signed;
            else {
              outflow -= signed;
              spending[r.category as string] =
                (spending[r.category as string] ?? 0) - signed;
            }
          }
        }
        return {
          currency: 'USD',
          totalAccountBalance: Number(cash.total),
          portfolioValue: Number(portfolio.value),
          allTimeGain: Number(portfolio.gain) + Number(realized.gain),
          netFlow7Days: days.map((d) => ({
            date: d.date,
            net: d.netMinor / 100,
          })),
          monthToDate: {
            inflow: inflow / 100,
            outflow: outflow / 100,
            net: (inflow - outflow) / 100,
          },
          spendingByCategory: Object.entries(spending).map(
            ([category, amount]) => ({ category, amount: amount / 100 }),
          ),
        };
      },
    );
  }
}
