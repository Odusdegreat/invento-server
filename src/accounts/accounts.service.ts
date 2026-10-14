import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, type Tx } from '../database/database.service.js';
import type { Session } from '../auth/auth.service.js';
import { fail } from '../common/api-error.js';

@Injectable()
export class AccountsService {
  constructor(@Inject(DatabaseService) private db: DatabaseService) {}

  // The gates every money-moving operation shares: ownership, freeze state and
  // the prototype's USD-only policy. Centralised so a new feature cannot
  // accidentally move money out of a frozen or foreign account.
  async payable(tx: Tx, s: Session, accountId: string) {
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

  async owned(s: Session, accountId: string) {
    const [account] = await this.db
      .sql`select id from accounts where id=${accountId} and "userId"=${s.userId}`;
    if (!account) fail('not_found', 'Account not found', 404);
    return account;
  }
}
