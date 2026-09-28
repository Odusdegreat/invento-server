import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { v7 as id } from 'uuid';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { DatabaseService } from '../database/database.service.js';
import { AuthService, digest, type Session } from './auth.service.js';
import { fail } from '../common/api-error.js';

@Injectable()
export class BiometricService {
  constructor(
    @Inject(DatabaseService) private db: DatabaseService,
    @Inject(AuthService) private auth: AuthService,
    @Inject(ConfigService) private config: ConfigService,
  ) {}
  private relyingParty() {
    const rpID = this.config.get<string>('WEBAUTHN_RP_ID'),
      origin = this.config.get<string>('WEBAUTHN_ORIGIN');
    if (!rpID || !origin)
      fail(
        'biometrics_disabled',
        'Device credential verification is not configured',
        403,
      );
    return { rpID, origin };
  }
  async registrationOptions(s: Session, stepUpToken?: string) {
    const { rpID } = this.relyingParty();
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      await this.auth.consume(tx, s, 'biometric_enroll', stepUpToken);
      const [user] = await tx`select email from users where id=${s.userId}`;
      const credentials =
        await tx`select id from biometric_credentials where "userId"=${s.userId} and "revokedAt" is null`;
      const options = await generateRegistrationOptions({
        rpName: 'Invento',
        rpID,
        userID: new TextEncoder().encode(s.userId),
        userName: user.email as string,
        attestationType: 'none',
        excludeCredentials: credentials.map((c) => ({ id: c.id as string })),
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'discouraged',
          userVerification: 'required',
        },
      });
      const challengeToken = randomBytes(32).toString('base64url');
      await tx`insert into auth_challenges(id,"userId","deviceId",purpose,"tokenHash",payload,"expiresAt") values (${id()},${s.userId},${s.deviceId},'webauthn_registration',${digest(challengeToken)},${tx.json({ challenge: options.challenge })},now()+interval '2 minutes')`;
      return { challengeToken, options, expiresIn: 120 };
    });
  }
  async register(
    s: Session,
    challengeToken: string,
    response: RegistrationResponseJSON,
  ) {
    const { rpID, origin } = this.relyingParty();
    const result = await this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const [challenge] =
        await tx`update auth_challenges set "consumedAt"=now() where "tokenHash"=${digest(challengeToken)} and "userId"=${s.userId} and "deviceId"=${s.deviceId} and purpose='webauthn_registration' and "expiresAt">now() and "consumedAt" is null returning payload`;
      if (!challenge) return null;
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge.payload.challenge as string,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch {
        return null;
      }
      if (
        !verification.verified ||
        verification.registrationInfo.credentialDeviceType !== 'singleDevice' ||
        verification.registrationInfo.credentialBackedUp
      )
        return null;
      const credential = verification.registrationInfo.credential;
      const rows =
        await tx`insert into biometric_credentials(id,"userId","publicKey",counter,"deviceType") values (${credential.id},${s.userId},${Buffer.from(credential.publicKey)},${credential.counter},'singleDevice') on conflict(id) do nothing returning id`;
      if (!rows.length) return null;
      await tx`update security_settings set "biometricsEnabled"=true where "userId"=${s.userId}`;
      return { ok: true, credentialId: credential.id };
    });
    if (!result)
      fail(
        'invalid_device_assertion',
        'Device registration proof is invalid, expired or unsupported',
        403,
      );
    return result;
  }
  async challenge(s: Session, action: string) {
    const { rpID } = this.relyingParty();
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const [settings] =
        await tx`select "biometricsEnabled" from security_settings where "userId"=${s.userId}`;
      const credentials =
        await tx`select id from biometric_credentials where "userId"=${s.userId} and "revokedAt" is null`;
      if (!settings.biometricsEnabled || !credentials.length)
        fail(
          'biometrics_disabled',
          'No active device credential is enrolled',
          403,
        );
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
        allowCredentials: credentials.map((c) => ({ id: c.id as string })),
      });
      const challengeToken = randomBytes(32).toString('base64url');
      await tx`insert into auth_challenges(id,"userId","deviceId",purpose,"tokenHash",action,payload,"expiresAt") values (${id()},${s.userId},${s.deviceId},'webauthn_authentication',${digest(challengeToken)},${action},${tx.json({ challenge: options.challenge })},now()+interval '2 minutes')`;
      return { challengeToken, options, expiresIn: 120 };
    });
  }
  async verify(
    s: Session,
    challengeToken: string,
    response: AuthenticationResponseJSON,
  ) {
    const { rpID, origin } = this.relyingParty();
    const result = await this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      const [settings] =
        await tx`select "biometricsEnabled" from security_settings where "userId"=${s.userId}`;
      if (!settings.biometricsEnabled) return null;
      const [challenge] =
        await tx`update auth_challenges set "consumedAt"=now() where "tokenHash"=${digest(challengeToken)} and "userId"=${s.userId} and "deviceId"=${s.deviceId} and purpose='webauthn_authentication' and "expiresAt">now() and "consumedAt" is null returning payload,action`;
      if (!challenge) return null;
      if (typeof response.id !== 'string') return null;
      const [credential] =
        await tx`select * from biometric_credentials where id=${response.id} and "userId"=${s.userId} and "revokedAt" is null for update`;
      if (!credential) return null;
      let verified;
      try {
        verified = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.payload.challenge as string,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: credential.id as string,
            publicKey: new Uint8Array(credential.publicKey as Buffer),
            counter: Number(credential.counter),
          },
        });
      } catch {
        return null;
      }
      if (
        !verified.verified ||
        verified.authenticationInfo.credentialDeviceType !== 'singleDevice' ||
        verified.authenticationInfo.credentialBackedUp
      )
        return null;
      await tx`update biometric_credentials set counter=${verified.authenticationInfo.newCounter} where id=${credential.id}`;
      const stepUpToken = randomBytes(32).toString('base64url');
      await tx`insert into step_up_tokens(id,"userId","deviceId","tokenHash",action,"expiresAt") values (${id()},${s.userId},${s.deviceId},${digest(stepUpToken)},${challenge.action},now()+interval '2 minutes')`;
      return { ok: true, stepUpToken, expiresIn: 120 };
    });
    if (!result)
      fail(
        'invalid_device_assertion',
        'Device confirmation is invalid, expired or already used',
        403,
      );
    return result;
  }
  async list(s: Session) {
    return this.db
      .sql`select id,"deviceType","createdAt" from biometric_credentials where "userId"=${s.userId} and "revokedAt" is null order by "createdAt"`;
  }
  async revoke(s: Session, credentialId: string, stepUpToken?: string) {
    return this.db.sql.begin(async (tx) => {
      await this.auth.lock(tx, s);
      await this.auth.consume(tx, s, 'security_downgrade', stepUpToken);
      const rows =
        await tx`update biometric_credentials set "revokedAt"=now() where id=${credentialId} and "userId"=${s.userId} and "revokedAt" is null returning id`;
      if (!rows.length) fail('not_found', 'Device credential not found', 404);
      await tx`update security_settings set "biometricsEnabled"=exists(select 1 from biometric_credentials where "userId"=${s.userId} and "revokedAt" is null) where "userId"=${s.userId}`;
      return { ok: true };
    });
  }
}
