import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  Length,
  Matches,
  IsIn,
  IsObject,
} from 'class-validator';
import { actions, StepDto } from '../api/dto.js';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
export class PasswordProofDto extends StepDto {
  @ApiProperty() @IsString() @Length(1, 128) password: string;
}
export class TokenDto {
  @ApiProperty() @IsString() @Length(32, 200) token: string;
}
export class OtpDto {
  @ApiProperty() @Matches(/^\d{6}$/) code: string;
}
export class DisableMfaDto extends PasswordProofDto {
  @ApiProperty() @Matches(/^\d{6}$/) code: string;
}
export class MfaLoginDto extends OtpDto {
  @ApiProperty() @IsString() @Length(32, 200) challengeToken: string;
}
export class BiometricChallengeDto {
  @ApiProperty({ enum: actions }) @IsIn(actions) action: string;
}
export class RegistrationProofDto {
  @ApiProperty() @IsString() @Length(32, 200) challengeToken: string;
  @ApiProperty({ type: Object }) @IsObject() response: RegistrationResponseJSON;
}
export class AuthenticationProofDto {
  @ApiProperty() @IsString() @Length(32, 200) challengeToken: string;
  @ApiProperty({ type: Object })
  @IsObject()
  response: AuthenticationResponseJSON;
}
export class PushTokenDto {
  @ApiProperty({ enum: ['expo', 'fcm', 'apns'] })
  @IsIn(['expo', 'fcm', 'apns'])
  provider: string;
  @ApiProperty() @IsString() @Length(16, 4096) token: string;
}
