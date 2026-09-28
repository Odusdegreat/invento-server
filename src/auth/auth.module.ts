import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { MailService } from './mail.service.js';
import { SecondFactorService } from './second-factor.service.js';
import { BiometricService } from './biometric.service.js';
import { SecurityFlowsController } from './security-flows.controller.js';
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, SecurityFlowsController],
  providers: [AuthService, MailService, SecondFactorService, BiometricService],
  exports: [AuthService],
})
export class AuthModule {}
