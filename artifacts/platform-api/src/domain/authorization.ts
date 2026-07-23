import { createHash } from "node:crypto";

import {
  PLATFORM_MODULE_KEYS,
  authorizationCodeExchangeSchema,
  authorizationRequestSchema,
  platformAssertionClaimsSchema,
  policyIntrospectionRequestSchema,
  policyIntrospectionResponseSchema,
  type AuthorizationCodeExchangeRequest,
  type AuthorizationRequest,
  type PlatformAssertionClaims,
  type PolicyIntrospectionRequest,
  type PolicyIntrospectionResponse,
} from "@workspace/platform-contract";
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
import type {
  PlatformAssertionSigner,
  PlatformAssertionSigningInput,
} from "./assertions.js";
import { mapDomainError, platformDomainError } from "./errors.js";
import type { OAuthClientRegistry } from "./oauth-clients.js";
import type {
  Account,
  AccountEntitlement,
  AuthorizationBindingRepository,
  AuthorizationCode,
  AuthSession,
  ClientInstallation,
  PlatformRepository,
} from "./repository.js";
import type {
  Clock,
  PlatformTransaction,
  RequestContext,
} from "./registration.js";
import { digestOpaqueToken, issueOpaqueToken } from "./security.js";
import {
  APOLLO_PORTAL_AUDIENCE,
  type AuthenticatedUser,
} from "./user-sessions.js";

export const AUTHORIZATION_CODE_TTL_MS = 60_000;
export const ASSERTION_EXPIRES_IN_SECONDS = 300 as const;

const requestContextSchema = z
  .object({ correlationId: z.string().uuid() })
  .strict();
const authenticatedUserSchema = z
  .object({
    accountId: z.string().uuid(),
    sessionId: z.string().uuid(),
    status: z.enum(["pending", "active"]),
    emailVerified: z.literal(true),
  })
  .strict();
const activeModuleKeys = new Set<string>(PLATFORM_MODULE_KEYS);

export interface IssuedAuthorizationCode {
  readonly rawCode: string;
  readonly redirectUri: string;
  readonly state: string;
}

export interface ExchangedAuthorizationCode {
  readonly assertion: string;
  readonly claims: PlatformAssertionClaims;
  readonly expiresIn: 300;
  readonly tokenType: "Bearer";
}

export type AuthorizationServiceRepository =
  AuthorizationBindingRepository &
    Pick<
      PlatformRepository,
      "lockAccountById" | "listAccountEntitlements" | "insertAuditEvent"
    >;

type AssertionSigner = Pick<PlatformAssertionSigner, "sign">;

function invalidRequest(): never {
  throw platformDomainError("invalid_request");
}

function invalidClient(): never {
  throw platformDomainError("invalid_client");
}

function invalidGrant(): never {
  throw platformDomainError("invalid_grant");
}

function accountAccessDenied(): never {
  throw platformDomainError("account_access_denied");
}

function policyUnavailable(): never {
  throw platformDomainError("policy_unavailable");
}

function finiteNow(clock: Clock): Date {
  const now = clock();
  if (!Number.isFinite(now.getTime())) policyUnavailable();
  return now;
}

function dateIsFinite(value: Date | null): boolean {
  return value === null || Number.isFinite(value.getTime());
}

function accountDatesAreFinite(account: Account): boolean {
  return (
    dateIsFinite(account.emailVerifiedAt) &&
    dateIsFinite(account.activatedAt) &&
    dateIsFinite(account.suspendedAt) &&
    dateIsFinite(account.deletedAt) &&
    dateIsFinite(account.createdAt) &&
    dateIsFinite(account.updatedAt)
  );
}

function sessionDatesAreFinite(session: AuthSession): boolean {
  return (
    dateIsFinite(session.expiresAt) &&
    dateIsFinite(session.revokedAt) &&
    dateIsFinite(session.createdAt) &&
    dateIsFinite(session.lastSeenAt)
  );
}

function installationDatesAreFinite(
  installation: ClientInstallation,
): boolean {
  return (
    dateIsFinite(installation.firstSeenAt) &&
    dateIsFinite(installation.lastSeenAt) &&
    dateIsFinite(installation.revokedAt)
  );
}

function authorizationCodeDatesAreFinite(code: AuthorizationCode): boolean {
  return (
    dateIsFinite(code.expiresAt) &&
    dateIsFinite(code.consumedAt) &&
    dateIsFinite(code.createdAt)
  );
}

function entitlementDatesAreFinite(
  entitlement: AccountEntitlement,
): boolean {
  return (
    dateIsFinite(entitlement.expiresAt) &&
    dateIsFinite(entitlement.revokedAt) &&
    dateIsFinite(entitlement.createdAt) &&
    dateIsFinite(entitlement.updatedAt)
  );
}

function liveEntitlementKeys(
  entitlements: readonly AccountEntitlement[],
  accountId: string,
  now: Date,
): (typeof PLATFORM_MODULE_KEYS)[number][] {
  const keys = new Set<(typeof PLATFORM_MODULE_KEYS)[number]>();
  for (const entitlement of entitlements) {
    if (
      entitlement.accountId !== accountId ||
      !entitlementDatesAreFinite(entitlement)
    ) {
      policyUnavailable();
    }
    const active =
      entitlement.moduleState === "active" &&
      entitlement.revokedAt === null &&
      (entitlement.expiresAt === null ||
        entitlement.expiresAt.getTime() > now.getTime());
    if (!active) continue;
    if (!activeModuleKeys.has(entitlement.moduleKey)) policyUnavailable();
    keys.add(
      entitlement.moduleKey as (typeof PLATFORM_MODULE_KEYS)[number],
    );
  }
  return [...keys].sort();
}

function accountIsActive(account: Account): boolean {
  return account.status === "active" && account.emailVerifiedAt !== null;
}

function portalSessionIsLive(session: AuthSession, now: Date): boolean {
  return (
    session.audience === APOLLO_PORTAL_AUDIENCE &&
    session.revokedAt === null &&
    session.expiresAt.getTime() > now.getTime()
  );
}

function installationIsActive(installation: ClientInstallation): boolean {
  return installation.revokedAt === null;
}

function codeBindingIsConsistent(
  initial: AuthorizationCode,
  fresh: AuthorizationCode,
): boolean {
  return (
    fresh.id === initial.id &&
    fresh.accountId === initial.accountId &&
    fresh.authSessionId === initial.authSessionId &&
    fresh.installationId === initial.installationId
  );
}

function codeIsExchangeable(
  code: AuthorizationCode,
  request: AuthorizationCodeExchangeRequest,
  now: Date,
): boolean {
  const remainingLifetime =
    code.expiresAt.getTime() - now.getTime();
  return (
    code.clientId === request.clientId &&
    code.redirectUri === request.redirectUri &&
    code.pkceMethod === "S256" &&
    code.pkceChallenge === pkceS256(request.codeVerifier) &&
    code.consumedAt === null &&
    code.createdAt.getTime() <= now.getTime() &&
    code.createdAt.getTime() < code.expiresAt.getTime() &&
    remainingLifetime > 0 &&
    remainingLifetime <= AUTHORIZATION_CODE_TTL_MS
  );
}

function redirectOrigin(redirectUri: string): string {
  return new URL(redirectUri).origin;
}

function validateConsumedCode(
  consumed: AuthorizationCode,
  expected: AuthorizationCode,
  now: Date,
): void {
  if (
    !authorizationCodeDatesAreFinite(consumed) ||
    !codeBindingIsConsistent(expected, consumed) ||
    consumed.consumedAt?.getTime() !== now.getTime()
  ) {
    policyUnavailable();
  }
}

export function pkceS256(verifier: string): string {
  return createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
}

export class AuthorizationService {
  constructor(
    private readonly pool: Pool,
    private readonly repository: AuthorizationServiceRepository,
    private readonly clients: OAuthClientRegistry,
    private readonly signer: AssertionSigner,
    private readonly clock: Clock,
    private readonly introspectionClientId: string,
    private readonly transaction: PlatformTransaction = withPlatformTransaction,
  ) {}

  async issueCode(
    user: AuthenticatedUser,
    request: AuthorizationRequest,
    context: RequestContext,
  ): Promise<IssuedAuthorizationCode> {
    const parsedUser = authenticatedUserSchema.safeParse(user);
    if (!parsedUser.success || parsedUser.data.status !== "active") {
      accountAccessDenied();
    }
    const parsedRequest = authorizationRequestSchema.safeParse(request);
    const parsedContext = requestContextSchema.safeParse(context);
    if (!parsedRequest.success || !parsedContext.success) invalidRequest();
    const client = this.clients.get(parsedRequest.data.clientId);
    if (
      client === null ||
      !client.redirectUris.includes(parsedRequest.data.redirectUri)
    ) {
      invalidRequest();
    }

    try {
      return await this.transaction(this.pool, async (databaseClient) => {
        await setAccountContext(databaseClient, parsedUser.data.accountId);
        const account = await this.repository.lockAccountById(
          databaseClient,
          parsedUser.data.accountId,
        );
        const session = await this.repository.lockSessionById(
          databaseClient,
          parsedUser.data.sessionId,
        );
        if (
          account !== null &&
          (account.id !== parsedUser.data.accountId ||
            !accountDatesAreFinite(account))
        ) {
          policyUnavailable();
        }
        if (
          session !== null &&
          (!sessionDatesAreFinite(session) ||
            session.id !== parsedUser.data.sessionId ||
            session.accountId !== parsedUser.data.accountId)
        ) {
          policyUnavailable();
        }
        const now = finiteNow(this.clock);
        if (
          account === null ||
          session === null ||
          !accountIsActive(account) ||
          !portalSessionIsLive(session, now)
        ) {
          accountAccessDenied();
        }

        const upserted = await this.repository.upsertClientInstallation(
          databaseClient,
          {
            installationId: parsedRequest.data.installationId,
            accountId: account.id,
            label: parsedRequest.data.installationLabel,
            seenAt: now,
          },
        );
        const locked = await this.repository.lockClientInstallation(
          databaseClient,
          parsedRequest.data.installationId,
        );
        if (
          upserted.accountId !== account.id ||
          upserted.id !== parsedRequest.data.installationId ||
          !installationDatesAreFinite(upserted) ||
          (locked !== null &&
            (locked.accountId !== account.id ||
              locked.id !== parsedRequest.data.installationId ||
              !installationDatesAreFinite(locked)))
        ) {
          policyUnavailable();
        }
        if (locked === null || !installationIsActive(locked)) {
          accountAccessDenied();
        }

        const token = issueOpaqueToken();
        const expiresAt = new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS);
        const created = await this.repository.createAuthorizationCode(
          databaseClient,
          {
            accountId: account.id,
            authSessionId: session.id,
            installationId: locked.id,
            codeDigest: token.digest,
            stateDigest: digestOpaqueToken(parsedRequest.data.state),
            clientId: client.clientId,
            redirectUri: parsedRequest.data.redirectUri,
            pkceChallenge: parsedRequest.data.codeChallenge,
            nonce: parsedRequest.data.nonce,
            expiresAt,
          },
        );
        if (
          created.accountId !== account.id ||
          created.authSessionId !== session.id ||
          created.installationId !== locked.id ||
          created.clientId !== client.clientId ||
          created.redirectUri !== parsedRequest.data.redirectUri ||
          created.pkceChallenge !== parsedRequest.data.codeChallenge ||
          created.pkceMethod !== "S256" ||
          created.nonce !== parsedRequest.data.nonce ||
          created.expiresAt.getTime() !== expiresAt.getTime() ||
          created.consumedAt !== null ||
          !authorizationCodeDatesAreFinite(created)
        ) {
          policyUnavailable();
        }

        await appendAuditEvent(this.repository, databaseClient, {
          actorAccountId: account.id,
          targetType: "authorization_code",
          targetId: created.id,
          action: AUDIT_ACTIONS.authorizationCodeIssued,
          correlationId: parsedContext.data.correlationId,
          reason: SYSTEM_AUDIT_REASONS.oauthAuthorizationIssue,
          previousValue: null,
          newValue: {
            clientId: client.clientId,
            audience: client.audience,
            redirectOrigin: redirectOrigin(parsedRequest.data.redirectUri),
            installationId: locked.id,
            sessionId: session.id,
            expiresAt: expiresAt.toISOString(),
          },
        });
        return {
          rawCode: token.raw,
          redirectUri: parsedRequest.data.redirectUri,
          state: parsedRequest.data.state,
        };
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async exchangeCode(
    request: AuthorizationCodeExchangeRequest,
    rawClientSecret: string,
    context: RequestContext,
  ): Promise<ExchangedAuthorizationCode> {
    const parsedRequest = authorizationCodeExchangeSchema.safeParse(request);
    const parsedContext = requestContextSchema.safeParse(context);
    if (!parsedRequest.success || !parsedContext.success) invalidRequest();
    const client = this.clients.get(parsedRequest.data.clientId);
    if (
      client === null ||
      !this.clients.verifySecret(client, rawClientSecret)
    ) {
      invalidClient();
    }
    const now = finiteNow(this.clock);
    const codeDigest = digestOpaqueToken(parsedRequest.data.code);

    try {
      return await this.transaction(this.pool, async (databaseClient) => {
        const initial =
          await this.repository.lockAuthorizationCodeByDigest(
            databaseClient,
            codeDigest,
          );
        if (initial === null) invalidGrant();

        await setAccountContext(databaseClient, initial.accountId);
        const account = await this.repository.lockAccountById(
          databaseClient,
          initial.accountId,
        );
        const session = await this.repository.lockSessionById(
          databaseClient,
          initial.authSessionId,
        );
        const installation = await this.repository.lockClientInstallation(
          databaseClient,
          initial.installationId,
        );
        const fresh = await this.repository.lockAuthorizationCodeByDigest(
          databaseClient,
          codeDigest,
        );

        if (
          account !== null &&
          (account.id !== initial.accountId ||
            !accountDatesAreFinite(account))
        ) {
          policyUnavailable();
        }
        if (
          session !== null &&
          (session.id !== initial.authSessionId ||
            session.accountId !== initial.accountId ||
            !sessionDatesAreFinite(session))
        ) {
          policyUnavailable();
        }
        if (
          installation !== null &&
          (installation.id !== initial.installationId ||
            installation.accountId !== initial.accountId ||
            !installationDatesAreFinite(installation))
        ) {
          policyUnavailable();
        }
        if (
          fresh !== null &&
          (!codeBindingIsConsistent(initial, fresh) ||
            !authorizationCodeDatesAreFinite(fresh))
        ) {
          policyUnavailable();
        }
        if (
          account === null ||
          session === null ||
          installation === null ||
          fresh === null ||
          !accountIsActive(account) ||
          !portalSessionIsLive(session, now) ||
          !installationIsActive(installation) ||
          !client.redirectUris.includes(fresh.redirectUri) ||
          !codeIsExchangeable(fresh, parsedRequest.data, now)
        ) {
          invalidGrant();
        }

        const entitlements = liveEntitlementKeys(
          await this.repository.listAccountEntitlements(
            databaseClient,
            account.id,
          ),
          account.id,
          now,
        );
        const consumed = await this.repository.consumeAuthorizationCode(
          databaseClient,
          {
            authorizationCodeId: fresh.id,
            consumedAt: now,
          },
        );
        if (consumed === null) invalidGrant();
        validateConsumedCode(consumed, fresh, now);

        const signingInput: PlatformAssertionSigningInput = {
          accountId: account.id,
          sessionId: session.id,
          installationId: installation.id,
          nonce: fresh.nonce,
          audience: client.audience,
          entitlements,
        };
        const signed = await this.signer.sign(signingInput);
        const claims = platformAssertionClaimsSchema.parse(signed.claims);

        await appendAuditEvent(this.repository, databaseClient, {
          actorAccountId: account.id,
          targetType: "authorization_code",
          targetId: fresh.id,
          action: AUDIT_ACTIONS.authorizationCodeExchanged,
          correlationId: parsedContext.data.correlationId,
          reason: SYSTEM_AUDIT_REASONS.oauthAuthorizationExchange,
          previousValue: {
            clientId: client.clientId,
            audience: client.audience,
            installationId: installation.id,
            sessionId: session.id,
            expiresAt: fresh.expiresAt.toISOString(),
          },
          newValue: {
            clientId: client.clientId,
            audience: client.audience,
            redirectOrigin: redirectOrigin(fresh.redirectUri),
            installationId: installation.id,
            sessionId: session.id,
            expiresAt: new Date(claims.exp * 1_000).toISOString(),
            entitlements,
          },
        });
        return {
          assertion: signed.assertion,
          claims,
          expiresIn: ASSERTION_EXPIRES_IN_SECONDS,
          tokenType: "Bearer",
        };
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  async introspect(
    request: PolicyIntrospectionRequest,
    rawClientSecret: string,
  ): Promise<PolicyIntrospectionResponse> {
    const parsedRequest = policyIntrospectionRequestSchema.safeParse(request);
    if (!parsedRequest.success) invalidRequest();
    const introspectionClient = this.clients.get(this.introspectionClientId);
    if (
      introspectionClient === null ||
      introspectionClient.audience !== parsedRequest.data.audience ||
      !this.clients.verifySecret(introspectionClient, rawClientSecret)
    ) {
      invalidClient();
    }
    const now = finiteNow(this.clock);

    try {
      return await this.transaction(this.pool, async (databaseClient) => {
        await setAccountContext(
          databaseClient,
          parsedRequest.data.accountId,
        );
        const account = await this.repository.lockAccountById(
          databaseClient,
          parsedRequest.data.accountId,
        );
        const session = await this.repository.lockSessionById(
          databaseClient,
          parsedRequest.data.sessionId,
        );
        const installation = await this.repository.lockClientInstallation(
          databaseClient,
          parsedRequest.data.installationId,
        );

        if (
          account !== null &&
          (account.id !== parsedRequest.data.accountId ||
            !accountDatesAreFinite(account))
        ) {
          policyUnavailable();
        }
        if (
          session !== null &&
          (session.id !== parsedRequest.data.sessionId ||
            session.accountId !== parsedRequest.data.accountId ||
            !sessionDatesAreFinite(session))
        ) {
          policyUnavailable();
        }
        if (
          installation !== null &&
          (installation.id !== parsedRequest.data.installationId ||
            installation.accountId !== parsedRequest.data.accountId ||
            !installationDatesAreFinite(installation))
        ) {
          policyUnavailable();
        }
        if (
          account === null ||
          session === null ||
          installation === null ||
          !accountIsActive(account) ||
          !portalSessionIsLive(session, now) ||
          !installationIsActive(installation)
        ) {
          return policyIntrospectionResponseSchema.parse({ active: false });
        }

        const entitlements = liveEntitlementKeys(
          await this.repository.listAccountEntitlements(
            databaseClient,
            account.id,
          ),
          account.id,
          now,
        );
        return policyIntrospectionResponseSchema.parse({
          active: true,
          accountId: account.id,
          sessionId: session.id,
          installationId: installation.id,
          accountStatus: "active",
          entitlements,
          expiresAt: session.expiresAt.toISOString(),
        });
      });
    } catch (error) {
      throw mapDomainError(error);
    }
  }
}
