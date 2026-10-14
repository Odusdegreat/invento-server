import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/session.guard.js';
import { RateLimit } from '../common/rate-limit.js';
import { ExternalTransfersService } from './external-transfers.service.js';
import {
  CancelExternalTransferDto,
  ExternalTransferDto,
  ExternalTransferQueryDto,
  ExternalTransferQuoteDto,
} from './dto.js';

@ApiTags('external-transfers')
@ApiBearerAuth()
@Controller('external-transfers')
export class ExternalTransfersController {
  constructor(
    @Inject(ExternalTransfersService)
    private service: ExternalTransfersService,
  ) {}

  @RateLimit(20)
  @Post('quote')
  quote(@Req() r: AuthRequest, @Body() dto: ExternalTransferQuoteDto) {
    return this.service.quote(r.session, dto);
  }

  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @Post()
  create(
    @Req() r: AuthRequest,
    @Body() dto: ExternalTransferDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.service.create(r.session, dto, key);
  }

  @Get()
  async list(
    @Req() r: AuthRequest,
    @Query() query: ExternalTransferQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.service.list(r.session, query);
    if (rows.length === query.limit)
      res.setHeader('X-Next-Cursor', rows.at(-1)!.id as string);
    return rows;
  }

  @Get(':id')
  detail(@Req() r: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(r.session, id);
  }

  @Post(':id/cancel')
  cancel(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelExternalTransferDto,
  ) {
    return this.service.cancel(r.session, id, dto.version);
  }
}
