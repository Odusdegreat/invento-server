import {
  IsEmail,
  IsString,
  Length,
  Matches,
  ValidateIf,
  IsIn,
  IsNumber,
  IsUUID,
  MaxLength,
  Min,
  Max,
  IsBoolean,
  IsInt,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
function IsOptional() {
  return ValidateIf((_object: unknown, value: unknown) => value !== undefined);
}
export class LoginDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email: string;
  @ApiProperty() @IsString() @Length(1, 128) password: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  deviceName?: string;
}
export class RegisterDto extends LoginDto {
  @ApiProperty() @IsString() @Length(1, 100) @Matches(/\S/) fullName: string;
  @ApiProperty() @Matches(/^\+[1-9][0-9 ()-]{6,20}$/) phone: string;
}
export class ProfileDto {
  @ApiProperty() @IsString() @Length(1, 100) @Matches(/\S/) fullName: string;
  @ApiProperty() @IsEmail() @MaxLength(254) email: string;
  @ApiProperty() @Matches(/^\+[1-9][0-9 ()-]{6,20}$/) phone: string;
}
export class UpdateProfileDto extends PartialType(ProfileDto, {
  skipNullProperties: false,
}) {}
export class RefreshDto {
  @ApiProperty() @IsString() @Length(32, 200) refreshToken: string;
}
export const actions = [
  'transfer',
  'investment_order',
  'beneficiary_add',
  'pin_change',
  'password_change',
  'security_downgrade',
  'biometric_enroll',
  'two_factor_setup',
] as const;
export class VerifyPinDto {
  @ApiProperty() @Matches(/^\d{4}$/) pin: string;
  @ApiProperty({ enum: actions }) @IsIn(actions) action: string;
}
export class StepDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  stepUpToken?: string;
}
export class PinDto extends StepDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(32, 200)
  setupToken?: string;
  @ApiProperty() @Matches(/^\d{4}$/) pin: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}$/) confirmPin?: string;
}
export class ChangePasswordDto extends StepDto {
  @ApiProperty() @IsString() @Length(1, 128) current: string;
  @ApiProperty() @IsString() @Length(1, 128) next: string;
}
export class ResetRequestDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email: string;
}
export class ResetConfirmDto {
  @ApiProperty() @IsString() @Length(32, 200) token: string;
  @ApiProperty() @IsString() @Length(1, 128) newPassword: string;
}
export class QuoteDto {
  @ApiPropertyOptional({ description: 'Shareable account UUID for an internal sandbox transfer' })
  @IsOptional() @IsUUID() recipientAccountId?: string;
  @ApiProperty() @IsUUID() fromAccountId: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1000000000)
  amount: number;
  @ApiPropertyOptional() @IsOptional() @IsIn(['USD']) currency?: string;
}
export class TransferDto extends QuoteDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() beneficiaryId?: string;
  @ApiPropertyOptional({ enum: ['success', 'failure'] })
  @IsOptional() @IsIn(['success', 'failure']) simulationOutcome?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() fee?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  stepUpToken?: string;
}
export class TopUpDto {
  @ApiProperty() @IsUUID() accountId: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(1000000)
  amount: number;
  @ApiProperty({ enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR', 'NGN', 'KES', 'ZAR', 'GHS'] })
  @IsIn(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR', 'NGN', 'KES', 'ZAR', 'GHS'])
  currency: string;
}
export class BeneficiaryDto extends StepDto {
  @ApiProperty() @IsString() @Length(1, 100) name: string;
  @ApiProperty() @IsString() @Length(1, 100) bank: string;
  @ApiProperty() @Matches(/^[0-9]{6,34}$/) accountNumber: string;
}
export class CardDto {
  @ApiProperty({ enum: ['visa', 'mastercard', 'amex', 'bank'] })
  @IsIn(['visa', 'mastercard', 'amex', 'bank'])
  brand: string;
  @ApiProperty() @IsString() @Length(1, 100) label: string;
  @ApiProperty() @Matches(/^\d{4}$/) last4: string;
  @ApiProperty() @Matches(/^(0[1-9]|1[0-2])\/\d{2}$/) expiry: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  holder?: string;
}
export class FrozenDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() frozen?: boolean;
}
export class AccountPatchDto {
  @ApiProperty() @IsBoolean() frozen: boolean;
}
export class CardPatchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  label?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() frozen?: boolean;
}
export class OrderDto extends StepDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty({ enum: ['buy', 'sell'] }) @IsIn(['buy', 'sell']) side:
    'buy' | 'sell';
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0.00000001)
  @Max(1000000)
  units: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() price?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() fee?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() fromAccountId?: string;
}
export class SecurityDto extends StepDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() twoFactorEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() biometricsEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(3600)
  autoLock?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() transactionAlerts?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() loginAlerts?: boolean;
}
export class PreferencesDto {
  @ApiProperty() @Matches(/^[A-Z]{3}$/) currency: string;
}
export class DisputeDto {
  @ApiProperty({ enum: ['not_recognised', 'wrong_amount'] })
  @IsIn(['not_recognised', 'wrong_amount'])
  reason: string;
}
export class DemoCardLinkInitDto {
  @ApiPropertyOptional({ enum: ['success', 'failed', 'pending'] })
  @IsOptional() @IsIn(['success', 'failed', 'pending']) defaultOutcome?: string;
}
export class DemoCardLinkConfirmDto {
  @ApiProperty() @IsString() @Length(1, 50) reference: string;
  @ApiPropertyOptional({ enum: ['success', 'failed', 'pending'] })
  @IsOptional() @IsIn(['success', 'failed', 'pending']) simulate?: string;
}
export class DemoPaymentAuthorizeDto {
  @ApiProperty() @IsString() @Length(1, 50) reference: string;
  @ApiProperty({ enum: ['success', 'failed', 'pending'] })
  @IsIn(['success', 'failed', 'pending']) outcome: string;
}
