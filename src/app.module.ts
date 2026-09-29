import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigurationModule } from './config/configuration.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { Public, SessionGuard } from './auth/session.guard.js';
import { LedgerService } from './ledger/ledger.service.js';
import { FinanceService } from './api/finance.service.js';
import { ResourcesService } from './api/resources.service.js';
import { DemoPaymentService } from './api/demo-payment.service.js';
import { ApiController } from './api/api.controller.js';
@Controller('health')
class HealthController {
  @Public() @Get() health() {
    return { status: 'ok', service: 'invento-server' };
  }
}
@Module({
  imports: [ConfigurationModule, DatabaseModule, AuthModule],
  controllers: [HealthController, ApiController],
  providers: [
    LedgerService,
    FinanceService,
    ResourcesService,
    DemoPaymentService,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
