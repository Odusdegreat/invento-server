import { Module } from '@nestjs/common';
import { SecurityController } from './security.controller.js';
import { SecurityService } from './security.service.js';

@Module({
  controllers: [SecurityController],
  providers: [SecurityService],
})
export class SecurityModule {}
