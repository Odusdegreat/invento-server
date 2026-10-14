import { Inject, Injectable } from '@nestjs/common';
import { v7 as id } from 'uuid';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { AuthService, type Session } from '../auth/auth.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { fail, failField, failFields } from '../common/api-error.js';
import {
  idempotencyHash,
  recordIdempotent,
  replayIdempotent,
  requireIdempotencyKey,
} from '../common/idempotency.js';
import { jsonRows } from '../common/json.js';
import { fee, minor, money, toMinor } from '../common/money.js';
import type {
  ExternalTransferDto,
  ExternalTransferQueryDto,
  ExternalTransferQuoteDto,
} from './dto.js';

const view = ` t.id,t."fromAccountId",t."externalBankId",b.code as "bankCode",b.name as "bankName",b.country,t."accountNumber",t."accountName",t."transactionId",t.amount,t.fee,t.currency,t.note,t.reference,t.status,t.version,t."createdAt",t."settledAt",t."cancelledAt"`;

@Injectable()
export class ExternalTransfersService {
  constructor(
    @Inject(DatabaseService) private db: DatabaseService,
    @Inject(AuthService) private auth: AuthService,
    @Inject(AccountsService) private accounts: AccountsService,
    @Inject(LedgerService) private ledger: LedgerService,
  ) {}

  async banks(search?: string) {
    const sql = this.db.sql;
    return this.db
      .sql`select id,code,name,country,currency,"minAmount","maxAmount" from external_banks
      ${search ? sql`where strpos(lower(name),lower(${search}))>0 or strpos(lower(code),lower(${search}))>0` : sql``}
      order by name`;
  }

  private async bank(tx: Tx, bankId: string) {
    const [bank] = await tx`select * from external_banks where id=${bankId}`;
    if (!bank) fail('not_found', 'External bank not found', 404);
    return bank;
  }

  private async prepare(tx: Tx, s: Session, dto: ExternalTransferQuoteDto) {
    const account = await this.accounts.payable(tx, s, dto.fromAccountId);
    const bank = await this.bank(tx, dto.externalBankId);
    if (bank.currency !== account.currency)
      fail('currency_mismatch', 'Bank and account currencies must match');
    const amount = minor(dto.amount);
    if (money(amount) < Number(bank.minAmount))
      failField('amount', `Amount must be at least ${bank.minAmount}`);
    if (money(amount) > Number(bank.maxAmount))
      failField('amount', `Amount must not exceed ${bank.maxAmount}`);
    const charge = fee(amount, 'transfer');
    return { account, bank, amount, charge };
  }

  async quote(s: Session, dto: ExternalTransferQuoteDto) {
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const { account, bank, amount, charge } = await this.prepare(tx, s, dto);
      const balance = await this.ledger.balance(tx, dto.fromAccountId);
      return {
        externalBankId: bank.id,
        bankCode: bank.code,
        bankName: bank.name,
        country: bank.country,
        amount: money(amount),
        fee: money(charge),
        total: money(amount + charge),
        currency: account.currency,
        minAmount: Number(bank.minAmount),
        maxAmount: Number(bank.maxAmount),
        sufficientFunds: balance >= amount + charge,
        quotedAt: new Date().toISOString(),
        simulated: true,
      };
    });
  }

  async create(s: Session, dto: ExternalTransferDto, key?: string) {
    const idempotencyKey = requireIdempotencyKey(key);
    const accountName = dto.accountName.trim();
    const requestHash = idempotencyHash('external_transfer', {
      fromAccountId: dto.fromAccountId,
      externalBankId: dto.externalBankId,
      accountNumber: dto.accountNumber,
      accountName,
      amount: dto.amount,
      note: dto.note ?? '',
      simulationOutcome: dto.simulationOutcome ?? 'success',
    });
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const cached = await replayIdempotent(
        tx,
        s.userId,
        idempotencyKey,
        requestHash,
      );
      if (cached) return cached;
      const { account, bank, amount, charge } = await this.prepare(tx, s, dto);
      if ((await this.ledger.balance(tx, dto.fromAccountId)) < amount + charge)
        fail('insufficient_funds', 'Insufficient funds');
      await this.auth.consume(tx, s, 'transfer', dto.stepUpToken);
      // 'pending' holds the funds in the settlement account so they can still be
      // returned by a cancellation; the other outcomes settle immediately.
      const outcome = dto.simulationOutcome ?? 'success';
      const rejected = outcome === 'failure';
      const status = rejected
        ? 'failed'
        : outcome === 'pending'
          ? 'pending'
          : 'completed';
      const reference = 'EXT-' + id();
      const settlement = rejected
        ? null
        : await this.ledger.system(
            tx,
            'settlement',
            account.currency as string,
          );
      const feeAccount = rejected
        ? null
        : await this.ledger.system(tx, 'fee', account.currency as string);
      const journalId = rejected
        ? null
        : await this.ledger.post(tx, reference, [
            {
              accountId: account.ledgerId as string,
              side: 'debit',
              amount: amount + charge,
            },
            { accountId: settlement as string, side: 'credit', amount },
            { accountId: feeAccount as string, side: 'credit', amount: charge },
          ]);
      const transferId = id();
      const transactionId = id();
      const counterparty = `${bank.name} ${accountName}`;
      await tx`insert into transactions(id,"userId","accountId","journalEntryId",amount,fee,currency,kind,category,description,counterparty,status,reference) values (${transactionId},${s.userId},${dto.fromAccountId},${journalId},${money(amount)},${rejected ? 0 : money(charge)},${account.currency},'out','transfer',${dto.note ?? 'External bank transfer'},${counterparty},${status === 'completed' ? 'completed' : status === 'pending' ? 'pending' : 'failed'},${reference})`;
      const [transfer] =
        await tx`insert into external_transfers(id,"userId","fromAccountId","externalBankId","accountNumber","accountName","transactionId","journalEntryId",amount,fee,currency,note,reference,status,"settledAt")
          values (${transferId},${s.userId},${dto.fromAccountId},${bank.id},${dto.accountNumber},${accountName},${transactionId},${journalId},${money(amount)},${rejected ? 0 : money(charge)},${account.currency},${dto.note ?? ''},${reference},${status},${status === 'pending' ? null : new Date()})
          returning id,"fromAccountId","externalBankId","accountNumber","accountName","transactionId",amount,fee,currency,note,reference,status,version,"createdAt","settledAt","cancelledAt"`;
      await tx`insert into notifications(id,"userId",kind,title,body,"targetType","targetId") values (${id()},${s.userId},'transaction',${status === 'completed' ? 'External transfer complete' : status === 'pending' ? 'External transfer pending' : 'External transfer failed'},${status === 'failed' ? 'The bank rejected this simulated transfer. No funds were debited.' : status === 'pending' ? 'Funds are held until the transfer settles or is cancelled.' : 'Your simulated external transfer is complete.'},'transaction',${transactionId})`;
      const response = {
        ...jsonRows(transfer),
        bankCode: bank.code,
        bankName: bank.name,
        total: money(amount + (rejected ? 0n : charge)),
        debitedAmount: rejected ? 0 : money(amount + charge),
        simulated: true,
      };
      await recordIdempotent(
        tx,
        s.userId,
        idempotencyKey,
        requestHash,
        response,
      );
      return response;
    });
  }

  async list(s: Session, query: ExternalTransferQueryDto) {
    if (query.accountId) await this.accounts.owned(s, query.accountId);
    const sql = this.db.sql;
    return jsonRows(
      await sql`select ${sql.unsafe(view)} from external_transfers t join external_banks b on b.id=t."externalBankId" where t."userId"=${s.userId}
      ${query.status ? sql`and t.status=${query.status}` : sql``}
      ${query.accountId ? sql`and t."fromAccountId"=${query.accountId}` : sql``}
      ${query.before ? sql`and t.id<${query.before}` : sql``}
      order by t.id desc limit ${query.limit}`,
    );
  }

  async detail(s: Session, transferId: string) {
    const [row] = await this.db
      .sql`select ${this.db.sql.unsafe(view)},case when t.status='failed' then 0 else t.amount+t.fee end as "debitedAmount" from external_transfers t join external_banks b on b.id=t."externalBankId" where t.id=${transferId} and t."userId"=${s.userId}`;
    if (!row) fail('not_found', 'External transfer not found', 404);
    return jsonRows({ ...row, simulated: true });
  }

  async cancel(s: Session, transferId: string, version?: number) {
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const [transfer] =
        await tx`select * from external_transfers where id=${transferId} and "userId"=${s.userId} for update`;
      if (!transfer) fail('not_found', 'External transfer not found', 404);
      if (transfer.status !== 'pending')
        fail(
          'conflict',
          `A ${transfer.status} external transfer cannot be cancelled`,
          409,
        );
      if (version !== undefined && transfer.version !== version)
        failFields(
          'conflict',
          'This external transfer changed since it was loaded',
          [{ key: 'version', message: 'Stale version' }],
          409,
        );
      // Corrections are made with a reversing entry; the original postings are
      // immutable, so the balance returns to what it was before the hold.
      const principal = toMinor(Number(transfer.amount));
      const charge = toMinor(Number(transfer.fee));
      const [account] =
        await tx`select l.id as "ledgerId" from accounts a join ledger_accounts l on l."accountId"=a.id where a.id=${transfer.fromAccountId}`;
      const settlement = await this.ledger.system(
        tx,
        'settlement',
        transfer.currency as string,
      );
      const feeAccount = await this.ledger.system(
        tx,
        'fee',
        transfer.currency as string,
      );
      const cancelJournal = await this.ledger.post(
        tx,
        (transfer.reference as string) + '-CANCEL',
        [
          { accountId: settlement, side: 'debit', amount: principal },
          { accountId: feeAccount, side: 'debit', amount: charge },
          {
            accountId: account.ledgerId as string,
            side: 'credit',
            amount: principal + charge,
          },
        ],
      );
      const [cancelled] =
        await tx`update external_transfers set status='cancelled',"cancelledAt"=now(),"cancelJournalEntryId"=${cancelJournal},version=version+1 where id=${transferId} returning id,"fromAccountId","externalBankId","accountNumber","accountName","transactionId",amount,fee,currency,note,reference,status,version,"createdAt","settledAt","cancelledAt"`;
      await tx`update transactions set status='reversed' where id=${transfer.transactionId}`;
      const [bank] =
        await tx`select code,name,country from external_banks where id=${transfer.externalBankId}`;
      return jsonRows({
        ...cancelled,
        bankCode: bank.code,
        bankName: bank.name,
        country: bank.country,
        refundedAmount: money(principal + charge),
        simulated: true,
      });
    });
  }
}
