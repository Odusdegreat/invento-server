import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/session.guard.js';
import { ResourcesService } from './resources.service.js';
import { FinanceService } from './finance.service.js';
import {
  UpdateProfileDto,
  QuoteDto,
  TransferDto,
  BeneficiaryDto,
  CardDto,
  FrozenDto,
  OrderDto,
  SecurityDto,
  PreferencesDto,
  DisputeDto,
  AccountPatchDto,
  CardPatchDto,
} from './dto.js';
import {
  PageDto,
  TransactionQueryDto,
  ProductsQueryDto,
  SummaryQueryDto,
} from './query.dto.js';
@ApiTags('resources')
@ApiBearerAuth()
@Controller(['api/v1', ''])
export class ApiController {
  constructor(
    @Inject(ResourcesService) private service: ResourcesService,
    @Inject(FinanceService) private finance: FinanceService,
  ) {}
  @Get('users/me') user(@Req() r: AuthRequest) {
    return this.service.user(r.session);
  }
  @Patch('users/me') updateUser(
    @Req() r: AuthRequest,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.service.updateUser(r.session, dto);
  }
  @Get('accounts') accounts(@Req() r: AuthRequest) {
    return this.service.accounts(r.session);
  }
  @Get('accounts/total-balance') totals(@Req() r: AuthRequest) {
    return this.service.totals(r.session);
  }
  @Get('accounts/summary') accountSummary(
    @Req() r: AuthRequest,
    @Query() q: SummaryQueryDto,
  ) {
    return this.service.accountSummary(r.session, q.currency);
  }
  @Patch('accounts/:id') updateAccount(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AccountPatchDto,
  ) {
    return this.service.freezeAccount(r.session, id, dto.frozen);
  }
  @Get('accounts/:id') account(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.accounts(r.session, id);
  }
  @Patch('accounts/:id/freeze') freezeAccount(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.freezeAccount(r.session, id, true);
  }
  @Patch('accounts/:id/unfreeze') unfreezeAccount(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.freezeAccount(r.session, id, false);
  }
  @Get('transactions') async transactions(
    @Req() r: AuthRequest,
    @Query() q: TransactionQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.service.transactions(r.session, q);
    if (rows.length === q.limit)
      res.setHeader('X-Next-Cursor', rows.at(-1)!.id as string);
    return rows;
  }
  @Get('transactions/summary') transactionTotals(
    @Req() r: AuthRequest,
    @Query() q: TransactionQueryDto,
  ) {
    return this.service.transactionTotals(r.session, q);
  }
  @Get('transactions/:id') transaction(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.transaction(r.session, id);
  }
  @Post(['transactions/:id/dispute', 'transactions/:id/disputes']) dispute(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DisputeDto,
  ) {
    return this.service.dispute(r.session, id, dto.reason);
  }
  @Post('transfers/quote') quote(@Req() r: AuthRequest, @Body() dto: QuoteDto) {
    return this.finance.quote(r.session, dto);
  }
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @Post('transfers')
  send(
    @Req() r: AuthRequest,
    @Body() dto: TransferDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.finance.send(r.session, dto, key);
  }
  @Get('transfers/:id') transfer(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.transfer(r.session, id);
  }
  @Get('transfers/:id/receipt') receipt(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.transfer(r.session, id);
  }
  @Get('beneficiaries') beneficiaries(@Req() r: AuthRequest) {
    return this.service.beneficiaries(r.session);
  }
  @Post('beneficiaries') addBeneficiary(
    @Req() r: AuthRequest,
    @Body() dto: BeneficiaryDto,
  ) {
    return this.service.addBeneficiary(r.session, dto);
  }
  @Delete('beneficiaries/:id') removeBeneficiary(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.removeBeneficiary(r.session, id);
  }
  @Get('cards') cards(@Req() r: AuthRequest) {
    return this.service.cards(r.session);
  }
  @Post('cards') addCard(@Req() r: AuthRequest, @Body() dto: CardDto) {
    return this.service.addCard(r.session, dto);
  }
  @Patch('cards/:id') updateCard(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CardPatchDto,
  ) {
    return this.service.updateCard(r.session, id, dto);
  }
  @Patch('cards') updateCards(
    @Req() r: AuthRequest,
    @Body() dto: AccountPatchDto,
  ) {
    return this.service.freezeCards(r.session, dto.frozen);
  }
  @Patch('cards/:id/default') defaultCard(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cardAction(r.session, id, 'default');
  }
  @Patch('cards/:id/freeze') freezeCard(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cardAction(r.session, id, 'freeze');
  }
  @Patch('cards/:id/unfreeze') unfreezeCard(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cardAction(r.session, id, 'unfreeze');
  }
  @Post('cards/freeze-all') freezeCards(
    @Req() r: AuthRequest,
    @Body() dto: FrozenDto,
  ) {
    return this.service.freezeCards(r.session, dto.frozen ?? true);
  }
  @Delete('cards/:id') removeCard(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cardAction(r.session, id, 'delete');
  }
  @Get('investments/products') products(@Query() query: ProductsQueryDto) {
    return this.service.products(undefined, query);
  }
  @Get('investments/products/:id') product(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.products(id);
  }
  @Get('investments/holdings') holdings(@Req() r: AuthRequest) {
    return this.service.holdings(r.session);
  }
  @Get('investments/orders') orders(@Req() r: AuthRequest) {
    return this.service.orders(r.session);
  }
  @Get('investments/orders/:id') orderDetails(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.order(r.session, id);
  }
  @Post('investments/orders/quote') orderQuote(
    @Req() r: AuthRequest,
    @Body() dto: OrderDto,
  ) {
    return this.finance.orderQuote(r.session, dto);
  }
  @Get('investments/portfolio') portfolio(@Req() r: AuthRequest) {
    return this.service.portfolio(r.session);
  }
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @Post('investments/orders')
  order(
    @Req() r: AuthRequest,
    @Body() dto: OrderDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.finance.order(r.session, dto, key);
  }
  @Get('investments/watchlist') watchlist(@Req() r: AuthRequest) {
    return this.service.watchlist(r.session);
  }
  @Post('investments/watchlist/:id') watch(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.watch(r.session, id, true);
  }
  @Put('investments/watchlist/:id') putWatch(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.watch(r.session, id, true);
  }
  @Delete('investments/watchlist/:id') unwatch(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.watch(r.session, id, false);
  }
  @Get('dashboard') dashboard(@Req() r: AuthRequest) {
    return this.service.dashboard(r.session);
  }
  @Get('home/summary') home(@Req() r: AuthRequest) {
    return this.service.home(r.session);
  }
  @Get('dashboard/summary') async dashboardSummary(@Req() r: AuthRequest) {
    const d = await this.service.dashboard(r.session);
    return { ...d, netWorth: d.totalAccountBalance + d.portfolioValue };
  }
  @Get('dashboard/cash-flow') async cashFlow(@Req() r: AuthRequest) {
    const d = await this.service.dashboard(r.session);
    return { currency: d.currency, days: d.netFlow7Days };
  }
  @Get('dashboard/spending') async spending(@Req() r: AuthRequest) {
    const d = await this.service.dashboard(r.session);
    return { currency: d.currency, categories: d.spendingByCategory };
  }
  @Get('notifications') async notifications(
    @Req() r: AuthRequest,
    @Query() q: PageDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.service.notifications(r.session, q.limit, q.before);
    if (rows.length === q.limit)
      res.setHeader('X-Next-Cursor', rows.at(-1)!.id as string);
    return rows;
  }
  @Get('notifications/unread-count')
  @Header('Content-Type', 'application/json')
  unread(@Req() r: AuthRequest) {
    return this.service.unread(r.session);
  }
  @Patch('notifications/read-all') readAll(@Req() r: AuthRequest) {
    return this.service.markRead(r.session);
  }
  @Post('notifications/read-all') readAllPost(@Req() r: AuthRequest) {
    return this.service.markRead(r.session);
  }
  @Patch('notifications/:id') readPatch(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.markRead(r.session, id);
  }
  @Patch('notifications/:id/read') read(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.markRead(r.session, id);
  }
  @Get('security') security(@Req() r: AuthRequest) {
    return this.service.security(r.session);
  }
  @Patch('security') updateSecurity(
    @Req() r: AuthRequest,
    @Body() dto: SecurityDto,
  ) {
    return this.service.updateSecurity(r.session, dto);
  }
  @Get('security/devices') devices(@Req() r: AuthRequest) {
    return this.service.devices(r.session);
  }
  @Delete('security/devices/:id') revoke(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.revoke(r.session, id);
  }
  @Post('security/devices/:id/revoke') revokePost(
    @Req() r: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.revoke(r.session, id);
  }
  @Get('preferences') preferences(@Req() r: AuthRequest) {
    return this.service.preferences(r.session);
  }
  @Patch('preferences') preference(
    @Req() r: AuthRequest,
    @Body() dto: PreferencesDto,
  ) {
    return this.service.preference(r.session, dto.currency);
  }
}
