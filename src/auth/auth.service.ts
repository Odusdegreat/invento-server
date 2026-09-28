import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { MailService } from './mail.service.js';
import { SecondFactorService } from './second-factor.service.js';
import { hash, verify, argon2id } from 'argon2';
import { v7 as id } from 'uuid';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { fail } from '../common/api-error.js';
import type {
  LoginDto,
  RegisterDto,
  VerifyPinDto,
  PinDto,
  ChangePasswordDto,
} from '../api/dto.js';

export interface Session {
  userId: string;
  deviceId: string;
}
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export const passwordHash = (value: string) =>
  hash(value, {
    type: argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
export function strongPassword(value: string) {
  if (value.length < 8 || value.length > 128)
    fail('weak_password', 'Password must contain 8 to 128 characters');
}
export function userView(row: Record<string, unknown>) {
  const {
    id,
    fullName,
    email,
    phone,
    avatarUri,
    memberSince,
    tier,
    kycVerified,
    emailVerified,
  } = row;
  return {
    id,
    fullName,
    email,
    phone,
    avatarUri,
    memberSince,
    tier,
    kycVerified,
    emailVerified,
  };
}
@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) readonly db: DatabaseService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(SecondFactorService) private readonly factors: SecondFactorService,
  ) {}
  async lock(tx: Tx, s: Session) {
    const [user] =
      await tx`select id from users where id=${s.userId} for update`;
    const [device] =
      await tx`select id from devices where id=${s.deviceId} and "userId"=${s.userId} and "revokedAt" is null`;
    if (!user || !device) fail('unauthorized', 'Session has ended', 401);
  }
  async tokens(tx: Tx, userId: string, deviceId: string) {
    const refreshToken = secret();
    await tx`insert into refresh_tokens(id,"userId","deviceId","tokenHash","expiresAt") values (${id()},${userId},${deviceId},${digest(refreshToken)},now()+interval '30 days')`;
    const accessToken = await this.jwt.signAsync(
      { sub: userId, deviceId },
      {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        expiresIn: '15m',
        issuer: 'invento',
        audience: 'invento-mobile',
        algorithm: 'HS256',
      },
    );
    return { token: accessToken, accessToken, refreshToken, expiresIn: 900 };
  }
  async register(dto: RegisterDto) {
    strongPassword(dto.password);
    const encoded = await passwordHash(dto.password);
    const result = await this.db.sql.begin(async (tx) => {
      const userId = id(),
        deviceId = id(),
        accountId = id();
      const [user] =
        await tx`insert into users(id,"fullName",email,phone,"passwordHash") values (${userId},${dto.fullName.trim()},${dto.email.toLowerCase()},${dto.phone},${encoded}) on conflict(email) do nothing returning *`;
      if (!user) fail('conflict', 'Unable to register with these details', 409);
      await tx`insert into security_settings("userId") values (${userId})`;
      await tx`insert into preferences("userId") values (${userId})`;
      await tx`insert into accounts(id,"userId",name,kind,currency,"maskedNumber") values (${accountId},${userId},'Everyday account','current','USD',${'•••• ' + randomBytes(2).readUInt16BE().toString().padStart(4, '0').slice(-4)})`;
      await tx`insert into ledger_accounts(id,"accountId",currency,purpose) values (${id()},${accountId},'USD','customer')`;
      await tx`insert into devices(id,"userId",name) values (${deviceId},${userId},${dto.deviceName ?? 'Mobile device'})`;
      return {
        user: userView(user),
        ...(await this.tokens(tx, userId, deviceId)),
      };
    });
    await this.requestEmailVerification(dto.email);
    return result;
  }
  async login(dto: LoginDto) {
    const result = await this.db.sql.begin(async (tx) => {
      const [user] =
        await tx`select * from users where email=${dto.email.toLowerCase()} for update`;
      if (!user) {
        await passwordHash(dto.password);
        return null;
      }
      if (user.loginLockedUntil && new Date(user.loginLockedUntil) > new Date())
        return null;
      if (!(await verify(user.passwordHash as string, dto.password))) {
        await tx`update users set "loginAttempts"="loginAttempts"+1,"loginLockedUntil"=case when "loginAttempts"+1>=5 then now()+interval '15 minutes' else null end where id=${user.id}`;
        return null;
      }
      await tx`update users set "loginAttempts"=0,"loginLockedUntil"=null where id=${user.id}`;
      const [settings] =
        await tx`select "twoFactorEnabled" from security_settings where "userId"=${user.id}`;
      if (settings.twoFactorEnabled) {
        const challengeToken = secret();
        await tx`update auth_challenges set "consumedAt"=now() where "userId"=${user.id} and purpose='mfa_login' and "consumedAt" is null`;
        await tx`insert into auth_challenges(id,"userId",purpose,"tokenHash",payload,"expiresAt") values (${id()},${user.id},'mfa_login',${digest(challengeToken)},${tx.json({ deviceName: dto.deviceName ?? 'Mobile device' })},now()+interval '5 minutes')`;
        return { requiresTwoFactor: true, challengeToken, expiresIn: 300 };
      }
      const deviceId = id();
      await tx`insert into devices(id,"userId",name) values (${deviceId},${user.id},${dto.deviceName ?? 'Mobile device'})`;
      return {
        user: userView(user),
        ...(await this.tokens(tx, user.id as string, deviceId)),
      };
    });
    if (!result)
      fail('invalid_credentials', 'Email or password is incorrect', 401);
    return result;
  }
  async session(token: string): Promise<Session> {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        deviceId: string;
      }>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        issuer: 'invento',
        audience: 'invento-mobile',
        algorithms: ['HS256'],
      });
      const [device] = await this.db
        .sql`update devices set "lastActiveAt"=now() where id=${payload.deviceId} and "userId"=${payload.sub} and "revokedAt" is null returning id`;
      if (!device) fail('unauthorized', 'Session has ended', 401);
      return { userId: payload.sub, deviceId: payload.deviceId };
    } catch {
      fail('unauthorized', 'Session is invalid or expired', 401);
    }
  }
  async refresh(token: string) {
    const result = await this.db.sql.begin(async (tx) => {
      const [found] =
        await tx`select "userId","deviceId" from refresh_tokens where "tokenHash"=${digest(token)}`;
      if (!found) return null;
      await tx`select id from users where id=${found.userId} for update`;
      const [row] =
        await tx`select * from refresh_tokens where "tokenHash"=${digest(token)} for update`;
      if (row.revokedAt) {
        await tx`update devices set "revokedAt"=now() where id=${row.deviceId}`;
        await tx`update refresh_tokens set "revokedAt"=now() where "deviceId"=${row.deviceId}`;
        return null;
      }
      const [device] =
        await tx`select id from devices where id=${row.deviceId} and "revokedAt" is null`;
      if (!device || new Date(row.expiresAt) <= new Date()) return null;
      await tx`update refresh_tokens set "revokedAt"=now() where id=${row.id}`;
      return this.tokens(tx, row.userId as string, row.deviceId as string);
    });
    if (!result)
      fail('unauthorized', 'Refresh token is invalid or expired', 401);
    return result;
  }
  async logout(s: Session) {
    await this.db.sql.begin(async (tx) => {
      await this.lock(tx, s);
      await tx`update devices set "revokedAt"=now() where id=${s.deviceId}`;
      await tx`update refresh_tokens set "revokedAt"=now() where "deviceId"=${s.deviceId}`;
      await tx`delete from push_tokens where "deviceId"=${s.deviceId}`;
    });
    return { ok: true };
  }
  async verifyPin(s: Session, dto: VerifyPinDto) {
    const result = await this.db.sql.begin(async (tx) => {
      await this.lock(tx, s);
      const [settings] =
        await tx`select * from security_settings where "userId"=${s.userId} for update`;
      if (
        !settings.pinHash ||
        (settings.pinLockedUntil &&
          new Date(settings.pinLockedUntil) > new Date())
      )
        return null;
      if (!(await verify(settings.pinHash as string, dto.pin))) {
        await tx`update security_settings set "pinAttempts"="pinAttempts"+1,"pinLockedUntil"=case when "pinAttempts"+1>=5 then now()+interval '15 minutes' else null end where "userId"=${s.userId}`;
        return null;
      }
      await tx`update security_settings set "pinAttempts"=0,"pinLockedUntil"=null where "userId"=${s.userId}`;
      const stepUpToken = secret();
      await tx`insert into step_up_tokens(id,"userId","deviceId","tokenHash",action,"expiresAt") values (${id()},${s.userId},${s.deviceId},${digest(stepUpToken)},${dto.action},now()+interval '2 minutes')`;
      return { ok: true, stepUpToken, expiresIn: 120 };
    });
    if (!result)
      fail(
        'invalid_pin',
        'PIN is incorrect, unavailable, or temporarily locked',
        403,
      );
    return result;
  }
  async consume(tx: Tx, s: Session, action: string, token?: string) {
    if (!token)
      fail('step_up_required', 'Confirm this action with your PIN', 403);
    const rows =
      await tx`update step_up_tokens set "consumedAt"=now() where "tokenHash"=${digest(token)} and "userId"=${s.userId} and "deviceId"=${s.deviceId} and action=${action} and "expiresAt">now() and "consumedAt" is null returning id`;
    if (!rows.length)
      fail(
        'invalid_step_up',
        'Confirmation is invalid, expired, or already used',
        403,
      );
  }
  async setPin(s: Session, dto: PinDto, _initial = false) {
    if (dto.confirmPin !== undefined && dto.pin !== dto.confirmPin)
      fail('weak_pin', 'PIN confirmation does not match');
    if (/^(\d)\1{3}$/.test(dto.pin))
      fail('weak_pin', 'Choose a PIN without four repeated digits');
    const encoded = await passwordHash(dto.pin);
    await this.db.sql.begin(async (tx) => {
      await this.lock(tx, s);
      const [settings] =
        await tx`select "pinHash" from security_settings where "userId"=${s.userId}`;
      if (!settings.pinHash) {
        if (!dto.setupToken)
          fail(
            'step_up_required',
            'Verify your password for initial PIN setup',
            403,
          );
        const rows =
          await tx`update auth_challenges set "consumedAt"=now() where "tokenHash"=${digest(dto.setupToken)} and "userId"=${s.userId} and "deviceId"=${s.deviceId} and purpose='pin_setup' and "consumedAt" is null and "expiresAt">now() returning id`;
        if (!rows.length)
          fail(
            'invalid_step_up',
            'PIN setup confirmation is invalid or expired',
            403,
          );
      } else await this.consume(tx, s, 'pin_change', dto.stepUpToken);
      await tx`update security_settings set "pinHash"=${encoded},"pinAttempts"=0,"pinLockedUntil"=null where "userId"=${s.userId}`;
      await tx`update step_up_tokens set "consumedAt"=now() where "userId"=${s.userId} and "consumedAt" is null`;
    });
    return { ok: true };
  }
  async changePassword(s: Session, dto: ChangePasswordDto) {
    strongPassword(dto.next);
    const encoded = await passwordHash(dto.next);
    await this.db.sql.begin(async (tx) => {
      await this.lock(tx, s);
      const [user] =
        await tx`select "passwordHash" from users where id=${s.userId}`;
      if (!(await verify(user.passwordHash as string, dto.current)))
        fail('invalid_credentials', 'Current password is incorrect', 403);
      await this.consume(tx, s, 'password_change', dto.stepUpToken);
      await tx`update users set "passwordHash"=${encoded} where id=${s.userId}`;
      await tx`update devices set "revokedAt"=now() where "userId"=${s.userId}`;
      await tx`update refresh_tokens set "revokedAt"=now() where "userId"=${s.userId}`;
      await tx`update password_reset_tokens set "consumedAt"=now() where "userId"=${s.userId}`;
      await tx`update auth_challenges set "consumedAt"=now() where "userId"=${s.userId}`;
      await tx`delete from push_tokens where "userId"=${s.userId}`;
    });
    return { ok: true };
  }
  async requestReset(email: string) {
    const token = secret();
    const messageId = id();
    const recipient = await this.db.sql.begin(async (tx) => {
      const [user] =
        await tx`select id from users where email=${email.toLowerCase()} for update`;
      if (!user) return;
      await tx`update password_reset_tokens set "consumedAt"=now() where "userId"=${user.id} and "consumedAt" is null`;
      await tx`insert into password_reset_tokens(id,"userId","tokenHash","expiresAt") values (${id()},${user.id},${digest(token)},now()+interval '15 minutes')`;
      return email.toLowerCase();
    });
    // Commit the token before contacting the mail provider. Delivery failure must
    // not reveal whether the requested account exists through the HTTP response.
    if (recipient) {
      try {
        await this.mail.sendPasswordReset(recipient, token, messageId);
      } catch {
        new Logger(AuthService.name).error(
          'Password reset email could not be delivered',
        );
      }
    }
    return { sent: true };
  }
  async confirmReset(token: string, newPassword: string) {
    strongPassword(newPassword);
    const encoded = await passwordHash(newPassword);
    await this.db.sql.begin(async (tx) => {
      const [found] =
        await tx`select "userId" from password_reset_tokens where "tokenHash"=${digest(token)}`;
      if (!found)
        fail('invalid_credentials', 'Reset token is invalid or expired', 403);
      await tx`select id from users where id=${found.userId} for update`;
      const [row] =
        await tx`update password_reset_tokens set "consumedAt"=now() where "tokenHash"=${digest(token)} and "consumedAt" is null and "expiresAt">now() returning "userId"`;
      if (!row)
        fail('invalid_credentials', 'Reset token is invalid or expired', 403);
      await tx`update users set "passwordHash"=${encoded},"loginAttempts"=0,"loginLockedUntil"=null where id=${row.userId}`;
      await tx`update devices set "revokedAt"=now() where "userId"=${row.userId}`;
      await tx`update refresh_tokens set "revokedAt"=now() where "userId"=${row.userId}`;
      await tx`update auth_challenges set "consumedAt"=now() where "userId"=${row.userId}`;
      await tx`delete from push_tokens where "userId"=${row.userId}`;
    });
    return { ok: true };
  }
  async requestEmailVerification(email: string) {
    const token = secret(),
      messageId = id();
    const recipient = await this.db.sql.begin(async (tx) => {
      const [user] =
        await tx`select id,email,"emailVerified" from users where email=${email.toLowerCase()} for update`;
      if (!user || user.emailVerified) return null;
      await tx`update email_verification_tokens set "consumedAt"=now() where "userId"=${user.id} and "consumedAt" is null`;
      await tx`insert into email_verification_tokens(id,"userId",email,"tokenHash","expiresAt") values (${messageId},${user.id},${user.email},${digest(token)},now()+interval '15 minutes')`;
      return user.email as string;
    });
    if (recipient)
      try {
        await this.mail.sendEmailVerification(recipient, token, messageId);
      } catch {
        new Logger(AuthService.name).error(
          'Verification email could not be delivered',
        );
      }
    return { sent: true };
  }
  async confirmEmail(token: string) {
    await this.db.sql.begin(async (tx) => {
      const [found] =
        await tx`select "userId" from email_verification_tokens where "tokenHash"=${digest(token)}`;
      if (!found)
        fail('invalid_verification', 'Verification is invalid or expired', 403);
      const [user] =
        await tx`select email from users where id=${found.userId} for update`;
      const [row] =
        await tx`update email_verification_tokens set "consumedAt"=now() where "tokenHash"=${digest(token)} and email=${user.email} and "expiresAt">now() and "consumedAt" is null returning id`;
      if (!row)
        fail('invalid_verification', 'Verification is invalid or expired', 403);
      await tx`update users set "emailVerified"=true where id=${found.userId}`;
    });
    return { ok: true };
  }
  async verifyPassword(tx: Tx, s: Session, password: string) {
    const [user] =
      await tx`select "passwordHash",email from users where id=${s.userId}`;
    if (!user || !(await verify(user.passwordHash as string, password)))
      fail('invalid_credentials', 'Current password is incorrect', 403);
    return user;
  }
  async pinSetup(s: Session, password: string) {
    return this.db.sql.begin(async (tx) => {
      await this.lock(tx, s);
      await this.verifyPassword(tx, s, password);
      const [settings] =
        await tx`select "pinHash" from security_settings where "userId"=${s.userId}`;
      if (settings.pinHash)
        fail('conflict', 'Use your current PIN to confirm a PIN change', 409);
      const setupToken = secret();
      await tx`update auth_challenges set "consumedAt"=now() where "userId"=${s.userId} and purpose='pin_setup'`;
      await tx`insert into auth_challenges(id,"userId","deviceId",purpose,"tokenHash","expiresAt") values (${id()},${s.userId},${s.deviceId},'pin_setup',${digest(setupToken)},now()+interval '2 minutes')`;
      return { setupToken, expiresIn: 120 };
    });
  }
  async enrollMfa(s: Session, password: string, stepUpToken?: string) {
    return this.db.sql.begin(async (tx) => {
      await this.lock(tx, s);
      const user = await this.verifyPassword(tx, s, password);
      const [settings] =
        await tx`select * from security_settings where "userId"=${s.userId}`;
      if (settings.twoFactorEnabled)
        fail(
          'conflict',
          'Disable your current authenticator before replacing it',
          409,
        );
      if (!settings.pinHash)
        fail(
          'step_up_required',
          'Set your transaction PIN before enrolling an authenticator',
          403,
        );
      await this.consume(tx, s, 'two_factor_setup', stepUpToken);
      const generated = this.factors.generate(user.email as string),
        encrypted = this.factors.encrypt(generated.secret);
      await tx`insert into mfa_credentials("userId","pendingEncrypted","pendingExpiresAt") values (${s.userId},${encrypted},now()+interval '5 minutes') on conflict("userId") do update set "pendingEncrypted"=excluded."pendingEncrypted","pendingExpiresAt"=excluded."pendingExpiresAt"`;
      return { ...generated, expiresIn: 300 };
    });
  }
  async checkOtp(tx: Tx, userId: string, code: string, pending = false) {
    const [row] =
      await tx`select * from mfa_credentials where "userId"=${userId} for update`;
    const encrypted = pending ? row?.pendingEncrypted : row?.secretEncrypted;
    if (
      !encrypted ||
      (row.lockedUntil && new Date(row.lockedUntil) > new Date()) ||
      (pending && new Date(row.pendingExpiresAt) <= new Date())
    )
      return false;
    const counter = this.factors.counter(
      encrypted as string,
      code,
      Number(row.lastCounter),
    );
    if (counter === null) {
      await tx`update mfa_credentials set attempts=attempts+1,"lockedUntil"=case when attempts+1>=5 then now()+interval '15 minutes' else null end where "userId"=${userId}`;
      return false;
    }
    await tx`update mfa_credentials set "lastCounter"=${counter},attempts=0,"lockedUntil"=null where "userId"=${userId}`;
    return true;
  }
  async confirmMfa(s: Session, code: string) {
    const valid = await this.db.sql.begin(async (tx) => {
      await this.lock(tx, s);
      if (!(await this.checkOtp(tx, s.userId, code, true))) return false;
      await tx`update mfa_credentials set "secretEncrypted"="pendingEncrypted","pendingEncrypted"=null,"pendingExpiresAt"=null where "userId"=${s.userId}`;
      await tx`update security_settings set "twoFactorEnabled"=true where "userId"=${s.userId}`;
      await tx`update devices set "revokedAt"=now() where "userId"=${s.userId} and id<>${s.deviceId}`;
      await tx`update refresh_tokens set "revokedAt"=now() where "userId"=${s.userId} and "deviceId"<>${s.deviceId}`;
      return true;
    });
    if (!valid)
      fail(
        'invalid_otp',
        'Authenticator code is invalid, expired, replayed or temporarily locked',
        403,
      );
    return { ok: true };
  }
  async loginMfa(challengeToken: string, code: string) {
    const result = await this.db.sql.begin(async (tx) => {
      const [found] =
        await tx`select "userId" from auth_challenges where "tokenHash"=${digest(challengeToken)} and purpose='mfa_login'`;
      if (!found) return null;
      const [user] =
        await tx`select * from users where id=${found.userId} for update`;
      const [challenge] =
        await tx`select * from auth_challenges where "tokenHash"=${digest(challengeToken)} and "consumedAt" is null and "expiresAt">now()`;
      if (!challenge || !(await this.checkOtp(tx, user.id as string, code)))
        return null;
      await tx`update auth_challenges set "consumedAt"=now() where id=${challenge.id}`;
      const deviceId = id();
      await tx`insert into devices(id,"userId",name) values (${deviceId},${user.id},${challenge.payload.deviceName as string})`;
      return {
        user: userView(user),
        ...(await this.tokens(tx, user.id as string, deviceId)),
      };
    });
    if (!result)
      fail(
        'invalid_otp',
        'Login confirmation is invalid, expired, replayed or temporarily locked',
        401,
      );
    return result;
  }
  async disableMfa(
    s: Session,
    password: string,
    code: string,
    stepUpToken?: string,
  ) {
    const valid = await this.db.sql.begin(async (tx) => {
      await this.lock(tx, s);
      await this.verifyPassword(tx, s, password);
      if (!(await this.checkOtp(tx, s.userId, code))) return false;
      await this.consume(tx, s, 'security_downgrade', stepUpToken);
      await tx`update security_settings set "twoFactorEnabled"=false where "userId"=${s.userId}`;
      await tx`delete from mfa_credentials where "userId"=${s.userId}`;
      await tx`update auth_challenges set "consumedAt"=now() where "userId"=${s.userId} and purpose='mfa_login'`;
      return true;
    });
    if (!valid)
      fail(
        'invalid_otp',
        'Authenticator code is invalid or temporarily locked',
        403,
      );
    return { ok: true };
  }
}
