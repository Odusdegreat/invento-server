import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { v7 as id } from 'uuid';
import { AuthService } from './auth.service.js';
import { BiometricService } from './biometric.service.js';
import { Public, type AuthRequest } from './session.guard.js';
import { ResetRequestDto, StepDto } from '../api/dto.js';
import {
  AuthenticationProofDto,
  BiometricChallengeDto,
  DisableMfaDto,
  MfaLoginDto,
  OtpDto,
  PasswordProofDto,
  PushTokenDto,
  RegistrationProofDto,
  TokenDto,
} from './security.dto.js';
import { fail } from '../common/api-error.js';

@ApiTags('security flows')
@ApiBearerAuth()
@Controller('')
export class SecurityFlowsController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(BiometricService) private biometric: BiometricService,
  ) {}
  @Public()
  @Post('auth/email-verification/request')
  @HttpCode(200)
  requestEmail(@Body() dto: ResetRequestDto) {
    return this.auth.requestEmailVerification(dto.email);
  }
  @Public()
  @Post('auth/email-verification/confirm')
  @HttpCode(200)
  confirmEmail(@Body() dto: TokenDto) {
    return this.auth.confirmEmail(dto.token);
  }
  @Post('auth/pin/setup/verify') @HttpCode(200) pinSetup(
    @Req() r: AuthRequest,
    @Body() dto: PasswordProofDto,
  ) {
    return this.auth.pinSetup(r.session, dto.password);
  }
  @Post('auth/2fa/enroll') @HttpCode(200) enroll(
    @Req() r: AuthRequest,
    @Body() dto: PasswordProofDto,
  ) {
    return this.auth.enrollMfa(r.session, dto.password, dto.stepUpToken);
  }
  @Post('auth/2fa/confirm') @HttpCode(200) confirm(
    @Req() r: AuthRequest,
    @Body() dto: OtpDto,
  ) {
    return this.auth.confirmMfa(r.session, dto.code);
  }
  @Public() @Post('auth/2fa/login/verify') @HttpCode(200) login(
    @Body() dto: MfaLoginDto,
  ) {
    return this.auth.loginMfa(dto.challengeToken, dto.code);
  }
  @Post('auth/2fa/disable') @HttpCode(200) disable(
    @Req() r: AuthRequest,
    @Body() dto: DisableMfaDto,
  ) {
    return this.auth.disableMfa(
      r.session,
      dto.password,
      dto.code,
      dto.stepUpToken,
    );
  }
  @Post('auth/biometric/registration/options')
  @HttpCode(200)
  registrationOptions(@Req() r: AuthRequest, @Body() dto: StepDto) {
    return this.biometric.registrationOptions(r.session, dto.stepUpToken);
  }
  @Post('auth/biometric/registration/verify') @HttpCode(200) register(
    @Req() r: AuthRequest,
    @Body() dto: RegistrationProofDto,
  ) {
    return this.biometric.register(r.session, dto.challengeToken, dto.response);
  }
  @Post('auth/step-up/biometric/challenge') @HttpCode(200) challenge(
    @Req() r: AuthRequest,
    @Body() dto: BiometricChallengeDto,
  ) {
    return this.biometric.challenge(r.session, dto.action);
  }
  @Post('auth/step-up/biometric') @HttpCode(200) verify(
    @Req() r: AuthRequest,
    @Body() dto: AuthenticationProofDto,
  ) {
    return this.biometric.verify(r.session, dto.challengeToken, dto.response);
  }
  @Get('security/biometric-credentials') credentials(@Req() r: AuthRequest) {
    return this.biometric.list(r.session);
  }
  @Delete('security/biometric-credentials/:id') revokeCredential(
    @Req() r: AuthRequest,
    @Param('id') credentialId: string,
    @Body() dto: StepDto,
  ) {
    return this.biometric.revoke(r.session, credentialId, dto.stepUpToken);
  }
  @Post('security/push-tokens') pushToken(
    @Req() r: AuthRequest,
    @Body() dto: PushTokenDto,
  ) {
    return this.auth.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, r.session);
      const [existing] =
        await tx`select "userId","deviceId" from push_tokens where token=${dto.token}`;
      if (
        existing &&
        (existing.userId !== r.session.userId ||
          existing.deviceId !== r.session.deviceId)
      )
        fail(
          'conflict',
          'Push token is already registered to another session',
          409,
        );
      const [row] =
        await tx`insert into push_tokens(id,"userId","deviceId",provider,token) values (${id()},${r.session.userId},${r.session.deviceId},${dto.provider},${dto.token}) on conflict("deviceId",provider) do update set token=excluded.token returning id,provider`;
      return { ...row, deliveryEnabled: false };
    });
  }
  @Delete('security/push-tokens/:id') removePush(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) tokenId: string,
  ) {
    return this.auth.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, r.session);
      const rows =
        await tx`delete from push_tokens where id=${tokenId} and "userId"=${r.session.userId} returning id`;
      if (!rows.length) fail('not_found', 'Push token not found', 404);
      return { ok: true };
    });
  }
}
