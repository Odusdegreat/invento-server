import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { AuthService, type Session } from '../auth/auth.service.js';
import { fail } from '../common/api-error.js';

export type SimulateOutcome = 'success' | 'failed' | 'pending';

export interface DemoCardLinkInitResponse {
  reference: string;
  authorizationUrl: string;
  amount: number;
  currency: string;
  testMode: true;
  demo: true;
}

export interface DemoCardLinkConfirmResponse {
  cardId: string;
  testMode: true;
  demo: true;
  status: SimulateOutcome;
}

@Injectable()
export class DemoPaymentService {
  constructor(
    @Inject(DatabaseService) private db: DatabaseService,
    @Inject(AuthService) private auth: AuthService,
    @Inject(ConfigService) private config: ConfigService,
  ) {}

  private demoEnabled() {
    const provider = this.config.get<string>('PAYMENT_PROVIDER');
    if (provider !== 'simulated' && provider !== undefined) {
      fail('payment_provider_mismatch', 'This deployment uses a different payment provider', 403);
    }
  }

  private generateReference(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = 'DEMO-';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  async initializeCardLink(s: Session): Promise<DemoCardLinkInitResponse> {
    this.demoEnabled();
    const [user] = await this.db.sql`select email, "fullName" from users where id=${s.userId}`;
    if (!user) fail('not_found', 'User not found', 404);

    const reference = this.generateReference();
    await this.db.sql`insert into demo_card_links(reference,"userId",email,outcome) values (${reference},${s.userId},${user.email},'pending')`;

    const authUrl = `/demo/payment/authorize?reference=${encodeURIComponent(reference)}`;
    return {
      reference,
      authorizationUrl: authUrl,
      amount: 100,
      currency: 'USD',
      testMode: true,
      demo: true,
    };
  }

  async confirmCardLink(
    reference: string,
    userId: string,
    simulate?: SimulateOutcome,
  ): Promise<DemoCardLinkConfirmResponse> {
    this.demoEnabled();
    const [link] = await this.db.sql`select * from demo_card_links where reference=${reference} and "userId"=${userId}`;
    if (!link) fail('not_found', 'Card link not found', 404);

    const outcome = simulate ?? (link.outcome as SimulateOutcome) ?? 'success';
    const validOutcomes: SimulateOutcome[] = ['success', 'failed', 'pending'];
    if (!validOutcomes.includes(outcome)) {
      fail('invalid_outcome', 'Invalid simulation outcome', 400);
    }

    if (outcome === 'failed') {
      await this.db.sql`update demo_card_links set outcome='failed', "completedAt"=now() where reference=${reference}`;
      return { cardId: '', testMode: true, demo: true, status: 'failed' };
    }

    if (outcome === 'pending') {
      await this.db.sql`update demo_card_links set outcome='pending' where reference=${reference}`;
      return { cardId: '', testMode: true, demo: true, status: 'pending' };
    }

    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, { userId, deviceId: '' });
      const [current] = await tx`select * from demo_card_links where reference=${reference} for update`;
      if (current.completedAt && current.cardId) {
        return { cardId: current.cardId, testMode: true, demo: true, status: 'success' };
      }

      const [user] = await tx`select "fullName" from users where id=${userId} for update`;
      const cardId = uuidv7();
      const [count] = await tx`select count(*)::int as count from cards where "userId"=${userId}`;
      await tx`insert into cards(id,"userId",brand,label,last4,expiry,holder,"isDefault") values
        (${cardId},${userId},'visa','Demo Card','4242','12/30',${user.fullName},${count.count === 0})`;
      await tx`update demo_card_links set outcome='success', "completedAt"=now(), "cardId"=${cardId} where reference=${reference}`;
      return { cardId, testMode: true, demo: true, status: 'success' };
    });
  }

  async authorizePage(reference: string) {
    this.demoEnabled();
    const [link] = await this.db.sql`select outcome from demo_card_links where reference=${reference}`;
    if (!link) fail('not_found', 'Invalid reference', 404);
    return { reference, outcome: link.outcome as SimulateOutcome, demo: true };
  }

  async simulateOutcome(reference: string, outcome: SimulateOutcome) {
    this.demoEnabled();
    await this.db.sql`update demo_card_links set outcome=${outcome} where reference=${reference}`;
    return { reference, outcome, demo: true };
  }
}