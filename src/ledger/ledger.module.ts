import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service.js';

@Module({
  providers: [LedgerService],
})
export class LedgerModule {}
