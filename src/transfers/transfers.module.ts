import { Module } from '@nestjs/common';
import { TransfersController } from './transfers.controller.js';
import { TransfersService } from './transfers.service.js';

@Module({
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
