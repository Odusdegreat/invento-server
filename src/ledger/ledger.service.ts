import { Injectable } from '@nestjs/common';
import { v7 as id } from 'uuid';
import type { Tx } from '../database/database.service.js';
import { fail } from '../common/api-error.js';
@Injectable()
export class LedgerService {
  async balance(tx: Tx, accountId: string): Promise<bigint> {
    const [row] =
      await tx`select "balanceMinor" from account_balances where id=${accountId}`;
    return BigInt(row?.balanceMinor ?? 0);
  }
  async system(tx: Tx, purpose: string, currency: string): Promise<string> {
    await tx`insert into ledger_accounts (id,purpose,currency) values (${id()},${purpose},${currency}) on conflict do nothing`;
    const [row] =
      await tx`select id from ledger_accounts where purpose=${purpose} and currency=${currency} and "accountId" is null`;
    return row.id as string;
  }
  async post(
    tx: Tx,
    reference: string,
    entries: { accountId: string; side: 'debit' | 'credit'; amount: bigint }[],
  ) {
    if (
      entries.length < 2 ||
      entries.some((p) => p.amount <= 0n) ||
      entries.reduce(
        (sum, p) => sum + (p.side === 'credit' ? p.amount : -p.amount),
        0n,
      ) !== 0n
    )
      fail('invalid_amount', 'Unbalanced ledger movement');
    const journalId = id();
    await tx`insert into journal_entries(id,reference) values (${journalId},${reference})`;
    for (const p of entries)
      await tx`insert into postings(id,"journalEntryId","ledgerAccountId",side,"amountMinor") values (${id()},${journalId},${p.accountId},${p.side},${p.amount.toString()})`;
    return journalId;
  }
}
