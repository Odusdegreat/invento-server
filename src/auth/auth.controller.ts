import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { Public, type AuthRequest } from './session.guard.js';
import {
  LoginDto,
  RegisterDto,
  RefreshDto,
  VerifyPinDto,
  PinDto,
  ChangePasswordDto,
  ResetRequestDto,
  ResetConfirmDto,
} from '../api/dto.js';
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private auth: AuthService) {}
  @Public() @Post('register') register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }
  @Public() @Post('login') @HttpCode(200) login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
  @Public() @Post('refresh') @HttpCode(200) refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }
  @Post('logout') @HttpCode(200) logout(@Req() r: AuthRequest) {
    return this.auth.logout(r.session);
  }
  @Public()
  @Post(['password/reset/request', 'password-reset/request'])
  @HttpCode(200)
  resetRequest(@Body() dto: ResetRequestDto) {
    return this.auth.requestReset(dto.email);
  }
  @Public()
  @Post(['password/reset/confirm', 'password-reset/confirm'])
  @HttpCode(200)
  resetConfirm(@Body() dto: ResetConfirmDto) {
    return this.auth.confirmReset(dto.token, dto.newPassword);
  }
  @Post(['pin/verify', 'step-up/verify']) @HttpCode(200) verifyPin(
    @Req() r: AuthRequest,
    @Body() dto: VerifyPinDto,
  ) {
    return this.auth.verifyPin(r.session, dto);
  }
  @Post('pin/set') @HttpCode(200) setPin(
    @Req() r: AuthRequest,
    @Body() dto: PinDto,
  ) {
    return this.auth.setPin(r.session, dto, true);
  }
  @Post(['pin', 'pin/change']) @HttpCode(200) changePin(
    @Req() r: AuthRequest,
    @Body() dto: PinDto,
  ) {
    return this.auth.setPin(r.session, dto);
  }
  @Post('password/change') @HttpCode(200) changePassword(
    @Req() r: AuthRequest,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(r.session, dto);
  }
}
