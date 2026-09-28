import { Module } from '@nestjs/common';
import { DisputesController } from './disputes.controller.js';
import { DisputesService } from './disputes.service.js';

@Module({
  controllers: [DisputesController],
  providers: [DisputesService],
})
export class DisputesModule {}
