import type { UserSessionRequest } from "@workspace/platform-contract";
import { userSessionRequestSchema } from "@workspace/platform-contract";
import {
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";
import type { Pool } from "pg";
import { z } from "zod";

import {
  appendAuditEvent,
  AUDIT_ACTIONS,
  SYSTEM_AUDIT_REASONS,
} from "./audit.js";
import { invalidCredentialsError, mapDomainError, platformDomainError } from "./errors.js";
import type {
  Account,
  AuthSession,
  Credential,
  PlatformRepository,
} from "./repository.js";
import type {
  Clock,
  PlatformTransaction,
  RequestContext,
} from "./registration.js";
import {
  digestOpaqueToken,
  hashPassword,
  issueOpaqueToken,
  normalizeEmail,
  type PasswordVerificationResult,
  verifyPassword,
} from "./security.js";

export const APOLLO_PORTAL_AUDIENCE = "apollo-portal";
export const PORTAL_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

const USER_LOGIN_DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$szCQnKfWN193s5UXLrflzQ$vdZdNDJWboaeMe/5bPcOGTz6/HERGqYqyRbPVtrWrs4";

const requestContextSchema = z
  .object({ correlationId: z.string().uuid() })
  .strict();
const exactSessionTokenSchema = z.string().min(1);

export interface UserSessionResult {
  readonly account: Account;
  readonly session: AuthSession;
  readonly rawToken: string;
}

export interface AuthenticatedUser {
  readonly accountId: string;
  readonly sessionId: string;
  readonly status: "pending" | "active";
  readonly emailVerified: true;
}

export interface UserPasswordVerification {
  readonly verify: (
    hash: string,
    password: string,
  ) => Promise<PasswordVerificationResult>;
  readonly dummyHash: string;
}

const DEFAULT_PASSWORD_VERIFICATION: UserPasswordVerification = Object.freeze({
  verify: verifyPassword,
  dummyHash: USER_LOGIN_DUMMY_PASSWORD_HASH,
});

function invalidCredentials(): never {
  throw invalidCredentialsError();
}

function policyUnavailable(): never {
  throw platformDomainError("policy_unavailable");
}

function finiteClockValue(clock: Clock): Date {
  const now = clock();
  if (!Number.isFinite(now.getTime())) policyUnavailable();
  return now;
}

function isPortalEligible(account: Account): account is Account & {
  readonly status: "pending" | "active";
  readonly emailVerifiedAt: Date;
} {
  return (
    account.emailVerifiedAt instanceof Date &&
    Number.isFinite(account.emailVerifiedAt.getTime()) &&
    (account.status === "pending" || account.status === "active")
  );
}

function hasMalformedEmailVerification(account: Account): boolean {
  return (
    account.emailVerifiedAt !== null &&
    (!(account.emailVerifiedAt instanceof Date) ||
      !Number.isFinite(account.emailVerifiedAt.getTime()))
  );
}

function sessionDatesAreFinite(session: AuthSession): boolean {
  return (
    Number.isFinite(session.expiresAt.getTime()) &&
    (session.revokedAt === null || Number.isFinite(session.revokedAt.getTime()))
  );
}

function publicSessionValue(
  session: AuthSession,
  status: "pending" | "active",
) {
  return {
    audience: session.audience,
    expiresAt: session.expiresAt.toISOString(),
    revokedAt: session.revokedAt?.toISOString() ?? null,
    status,
  };
}

export class UserSessionService {
  constructor(
    private readonly pool: Pool,
    private readonly repository: PlatformRepository,
    private readonly clock: Clock,
    private readonly transaction: PlatformTransaction = withPlatformTransaction,
    private readonly passwordVerification: UserPasswordVerification = DEFAULT_PASSWORD_VERIFICATION,
  ) {}

  async login(
    input: UserSessionRequest,
    context: RequestContext,
  ): Promise<UserSessionResult> {
    const parsedInput = userSessionRequestSchema.safeParse(input);
    const parsedContext = requestContextSchema.safeParse(context);
    if (!parsedInput.success || !parsedContext.success) invalidCredentials();

    try {
      return await this.transaction(this.pool, async (client) => {
        const candidate = await this.repository.findAccountByNormalizedEmail(
          client,
          normalizeEmail(parsedInput.data.email),
        );
        let account: Account | null = null;
        let credential: Credential | null = null;
        if (candidate !== null) {
          await setAccountContext(client, candidate.id);
          account = await this.repository.lockAccountById(client, candidate.id);
          credential = await this.repository.findCredentialByAccountId(
            client,
            candidate.id,
          );
        }
        const credentialIsConsistent =
          credential === null ||
          (candidate !== null && credential.accountId === candidate.id);
        const verification = await this.passwordVerification.verify(
          credential !== null && credentialIsConsistent
            ? credential.passwordHash
            : this.passwordVerification.dummyHash,
          parsedInput.data.password,
        );
        if (
          candidate !== null &&
          ((account !== null && account.id !== candidate.id) ||
            !credentialIsConsistent)
        ) {
          policyUnavailable();
        }
        if (account !== null && hasMalformedEmailVerification(account)) {
          policyUnavailable();
        }
        if (
          candidate === null ||
          account === null ||
          credential === null ||
          !verification.valid ||
          !isPortalEligible(account)
        ) {
          invalidCredentials();
        }

        const now = finiteClockValue(this.clock);
        if (verification.needsRehash) {
          await this.repository.updateCredential(client, {
            accountId: account.id,
            passwordHash: await hashPassword(parsedInput.data.password),
            passwordChangedAt: now,
          });
        }
        const token = issueOpaqueToken(32);
        const rotatedSessionCount =
          await this.repository.revokeSessionsForAccountByAudience(client, {
            accountId: account.id,
            audience: APOLLO_PORTAL_AUDIENCE,
            revokedAt: now,
          });
        const session = await this.repository.createSession(client, {
          accountId: account.id,
          installationId: null,
          sessionDigest: token.digest,
          audience: APOLLO_PORTAL_AUDIENCE,
          expiresAt: new Date(now.getTime() + PORTAL_SESSION_TTL_MS),
        });
        await appendAuditEvent(this.repository, client, {
          actorAccountId: account.id,
          targetType: "auth_session",
          targetId: session.id,
          action: AUDIT_ACTIONS.userSessionCreated,
          correlationId: parsedContext.data.correlationId,
          reason: SYSTEM_AUDIT_REASONS.userLogin,
          previousValue: null,
          newValue: {
            ...publicSessionValue(session, account.status),
            rotatedSessionCount,
          },
        });
        return { account, session, rawToken: token.raw };
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async authenticate(rawToken: string): Promise<AuthenticatedUser> {
    const parsedToken = exactSessionTokenSchema.safeParse(rawToken);
    if (!parsedToken.success) invalidCredentials();
    const digest = digestOpaqueToken(parsedToken.data);

    try {
      return await this.transaction(this.pool, async (client) => {
        const session = await this.repository.findSessionByDigest(client, digest);
        if (session === null) invalidCredentials();
        await setAccountContext(client, session.accountId);
        const account = await this.repository.lockAccountById(
          client,
          session.accountId,
        );
        const freshSession = await this.repository.lockSessionByDigest(
          client,
          digest,
        );
        if (
          account === null ||
          account.id !== session.accountId ||
          freshSession === null ||
          freshSession.id !== session.id ||
          freshSession.accountId !== session.accountId ||
          !sessionDatesAreFinite(freshSession)
        ) {
          policyUnavailable();
        }
        if (hasMalformedEmailVerification(account)) policyUnavailable();
        const now = finiteClockValue(this.clock);
        if (
          freshSession.audience !== APOLLO_PORTAL_AUDIENCE ||
          freshSession.revokedAt !== null ||
          freshSession.expiresAt.getTime() <= now.getTime() ||
          account === null ||
          !isPortalEligible(account)
        ) {
          invalidCredentials();
        }
        return {
          accountId: account.id,
          sessionId: freshSession.id,
          status: account.status,
          emailVerified: true,
        };
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async revoke(rawToken: string, context: RequestContext): Promise<void> {
    const parsedToken = exactSessionTokenSchema.safeParse(rawToken);
    const parsedContext = requestContextSchema.safeParse(context);
    if (!parsedToken.success || !parsedContext.success) invalidCredentials();
    const digest = digestOpaqueToken(parsedToken.data);

    try {
      await this.transaction(this.pool, async (client) => {
        const session = await this.repository.findSessionByDigest(client, digest);
        if (session === null) invalidCredentials();
        await setAccountContext(client, session.accountId);
        const account = await this.repository.lockAccountById(
          client,
          session.accountId,
        );
        const freshSession = await this.repository.lockSessionByDigest(
          client,
          digest,
        );
        if (
          account === null ||
          account.id !== session.accountId ||
          freshSession === null ||
          freshSession.id !== session.id ||
          freshSession.accountId !== session.accountId ||
          !sessionDatesAreFinite(freshSession)
        ) {
          policyUnavailable();
        }
        if (hasMalformedEmailVerification(account)) policyUnavailable();
        const now = finiteClockValue(this.clock);
        if (
          freshSession.audience !== APOLLO_PORTAL_AUDIENCE ||
          freshSession.revokedAt !== null ||
          freshSession.expiresAt.getTime() <= now.getTime() ||
          account === null ||
          !isPortalEligible(account)
        ) {
          invalidCredentials();
        }
        const previousValue = publicSessionValue(freshSession, account.status);
        const revoked = await this.repository.revokeSession(client, {
          sessionId: freshSession.id,
          revokedAt: now,
        });
        if (revoked === null) invalidCredentials();
        if (
          revoked.id !== freshSession.id ||
          revoked.accountId !== freshSession.accountId ||
          revoked.revokedAt === null ||
          !sessionDatesAreFinite(revoked)
        ) {
          policyUnavailable();
        }
        await appendAuditEvent(this.repository, client, {
          actorAccountId: account.id,
          targetType: "auth_session",
          targetId: freshSession.id,
          action: AUDIT_ACTIONS.userSessionRevoked,
          correlationId: parsedContext.data.correlationId,
          reason: SYSTEM_AUDIT_REASONS.userLogout,
          previousValue,
          newValue: publicSessionValue(revoked, account.status),
        });
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }
}
