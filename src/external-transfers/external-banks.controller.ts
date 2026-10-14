import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ExternalTransfersService } from './external-transfers.service.js';
import { ExternalBankQueryDto } from './dto.js';

@ApiTags('external-transfers')
@ApiBearerAuth()
@Controller('external-banks')
export class ExternalBanksController {
  constructor(
    @Inject(ExternalTransfersService)
    private service: ExternalTransfersService,
  ) {}

  @Get()
  banks(@Query() query: ExternalBankQueryDto) {
    return this.service.banks(query.search);
  }
}
