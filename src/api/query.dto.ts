import { Type } from 'class-transformer';
import {
  IsOptional,
  IsUUID,
  IsString,
  MaxLength,
  IsIn,
  IsInt,
  Min,
  Max,
  IsISO8601,
  Matches,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
export class PageDto {
  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
  @ApiPropertyOptional() @IsOptional() @IsUUID() before?: string;
}
export class TransactionQueryDto extends PageDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;
  @ApiPropertyOptional({ enum: ['in', 'out'] })
  @IsOptional()
  @IsIn(['in', 'out'])
  kind?: string;
  @ApiPropertyOptional({ enum: ['in', 'out'] })
  @IsOptional()
  @IsIn(['in', 'out'])
  type?: string;
  @ApiPropertyOptional({ description: 'Inclusive ISO-8601 timestamp' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;
  @ApiPropertyOptional({ description: 'Exclusive ISO-8601 timestamp' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
export class ProductsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional({
    enum: ['treasury', 'equity', 'etf', 'crypto', 'fixed-deposit'],
  })
  @IsOptional()
  @IsIn(['treasury', 'equity', 'etf', 'crypto', 'fixed-deposit'])
  assetClass?: string;
}
export class SummaryQueryDto {
  @ApiPropertyOptional({ default: 'USD' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
