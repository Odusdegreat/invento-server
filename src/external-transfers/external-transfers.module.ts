import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { ExternalBanksController } from './external-banks.controller.js';
import { ExternalTransfersController } from './external-transfers.controller.js';
import { ExternalTransfersService } from './external-transfers.service.js';

@Module({
  imports: [DatabaseModule, AuthModule, AccountsModule, LedgerModule],
  controllers: [ExternalBanksController, ExternalTransfersController],
  providers: [ExternalTransfersService],
})
export class ExternalTransfersModule {}
