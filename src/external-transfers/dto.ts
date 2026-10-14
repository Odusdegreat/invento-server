import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageDto } from '../api/query.dto.js';

export const simulationOutcomes = ['success', 'failure', 'pending'] as const;

export class ExternalBankQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class ExternalTransferQuoteDto {
  @ApiProperty() @IsUUID() fromAccountId: string;
  @ApiProperty() @IsUUID() externalBankId: string;
  @ApiProperty({
    description: 'Destination account number at the external bank',
  })
  @Matches(/^[0-9]{6,34}$/)
  accountNumber: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1000000)
  amount: number;
}

export class ExternalTransferDto extends ExternalTransferQuoteDto {
  @ApiProperty() @IsString() @Length(1, 100) @Matches(/\S/) accountName: string;
  @ApiPropertyOptional({ enum: simulationOutcomes })
  @IsOptional()
  @IsIn(simulationOutcomes)
  simulationOutcome?: string;
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

export class ExternalTransferQueryDto extends PageDto {
  @ApiPropertyOptional({
    enum: ['pending', 'completed', 'failed', 'cancelled'],
  })
  @IsOptional()
  @IsIn(['pending', 'completed', 'failed', 'cancelled'])
  status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
}

export class CancelExternalTransferDto {
  // Optional so a client that does not track versions can still cancel; when
  // present it must match, which turns a stale cancel into a 409.
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
}
