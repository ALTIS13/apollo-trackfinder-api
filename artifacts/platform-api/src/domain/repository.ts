import type {
  AccountStatus,
  RegistrationMode,
} from "@workspace/platform-contract";
import type { PoolClient } from "pg";

export interface RegistrationSettings {
  readonly id: string;
  readonly mode: RegistrationMode;
  readonly revision: number;
  readonly updatedByAccountId: string | null;
  readonly updatedAt: Date;
  readonly operatorBootstrapAccountId: string | null;
  readonly operatorBootstrapCompletedAt: Date | null;
}

export interface UpdateRegistrationSettingsInput {
  readonly mode: RegistrationMode;
  readonly updatedByAccountId: string | null;
}

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly emailVerifiedAt: Date | null;
  readonly activatedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateAccountInput {
  readonly normalizedEmail: string;
  readonly displayName: string;
}

export interface UpdateAccountStatusInput {
  readonly accountId: string;
  readonly status: AccountStatus;
  readonly changedAt: Date;
}

export interface MarkAccountEmailVerifiedInput {
  readonly accountId: string;
  readonly verifiedAt: Date;
}

export interface Credential {
  readonly accountId: string;
  readonly passwordHash: string;
  readonly passwordChangedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateCredentialInput {
  readonly accountId: string;
  readonly passwordHash: string;
  readonly passwordChangedAt: Date;
}

export interface UpdateCredentialInput extends CreateCredentialInput {}

export interface VerificationToken {
  readonly id: string;
  readonly accountId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateVerificationTokenInput {
  readonly accountId: string;
  readonly tokenDigest: string;
  readonly expiresAt: Date;
}

export interface ConsumeVerificationTokenInput {
  readonly verificationTokenId: string;
  readonly consumedAt: Date;
}

export interface Invitation {
  readonly id: string;
  readonly email: string | null;
  readonly expiresAt: Date;
  readonly usesLimit: number;
  readonly usesCount: number;
  readonly revokedAt: Date | null;
  readonly createdByAccountId: string | null;
  readonly reason: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateInvitationInput {
  readonly tokenDigest: string;
  readonly normalizedEmail: string | null;
  readonly expiresAt: Date;
  readonly usesLimit: number;
  readonly createdByAccountId: string | null;
  readonly reason: string;
}

export interface AddInvitationGrantsInput {
  readonly invitationId: string;
  readonly moduleIds: readonly string[];
}

export interface InvitationGrant {
  readonly invitationId: string;
  readonly moduleId: string;
  readonly moduleKey: string;
}

export interface IncrementInvitationUseInput {
  readonly invitationId: string;
  readonly usedAt: Date;
}

export interface RevokeInvitationInput {
  readonly invitationId: string;
  readonly revokedAt: Date;
}

export interface PlatformModule {
  readonly id: string;
  readonly moduleKey: string;
  readonly product: string;
  readonly displayName: string;
  readonly state: "active" | "disabled";
  readonly description: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AccountEntitlement {
  readonly id: string;
  readonly accountId: string;
  readonly moduleId: string;
  readonly moduleKey: string;
  readonly moduleState: "active" | "disabled";
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly source: string;
  readonly grantedByAccountId: string | null;
  readonly reason: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertAccountEntitlementInput {
  readonly accountId: string;
  readonly moduleId: string;
  readonly expiresAt: Date | null;
  readonly source: string;
  readonly grantedByAccountId: string | null;
  readonly reason: string;
}

export interface RevokeAccountEntitlementInput {
  readonly accountId: string;
  readonly moduleId: string;
  readonly revokedAt: Date;
  readonly reason: string;
}

export interface AuthSession {
  readonly id: string;
  readonly accountId: string;
  readonly installationId: string | null;
  readonly audience: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface CreateSessionInput {
  readonly accountId: string;
  readonly installationId: string | null;
  readonly sessionDigest: string;
  readonly audience: string;
  readonly expiresAt: Date;
}

export interface RevokeSessionInput {
  readonly sessionId: string;
  readonly revokedAt: Date;
}

export interface RevokeAllSessionsInput {
  readonly accountId: string;
  readonly revokedAt: Date;
}

export interface ClientInstallation {
  readonly id: string;
  readonly accountId: string;
  readonly label: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
}

export interface UpsertClientInstallationInput {
  readonly installationId: string;
  readonly accountId: string;
  readonly label: string;
  readonly seenAt: Date;
}

export interface AuthorizationCode {
  readonly id: string;
  readonly accountId: string;
  readonly authSessionId: string;
  readonly installationId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly pkceChallenge: string;
  readonly pkceMethod: "S256";
  readonly nonce: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateAuthorizationCodeInput {
  readonly accountId: string;
  readonly authSessionId: string;
  readonly installationId: string;
  readonly codeDigest: string;
  readonly stateDigest: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly pkceChallenge: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

export interface ConsumeAuthorizationCodeInput {
  readonly authorizationCodeId: string;
  readonly consumedAt: Date;
}

export interface InsertOperatorCapabilitiesInput {
  readonly accountId: string;
  readonly capabilities: readonly string[];
  readonly grantedByAccountId: string | null;
  readonly reason: string;
}

export interface RevokeSessionsForAccountByAudienceInput {
  readonly accountId: string;
  readonly audience: string;
  readonly revokedAt: Date;
}

export type AuditValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditValue[]
  | { readonly [key: string]: AuditValue };

export interface AuditEvent {
  readonly id: string;
  readonly actorAccountId: string | null;
  readonly targetType: string;
  readonly targetId: string;
  readonly action: string;
  readonly correlationId: string;
  readonly reason: string;
  readonly previousValue: AuditValue;
  readonly newValue: AuditValue;
  readonly occurredAt: Date;
}

export interface InsertAuditEventInput {
  readonly actorAccountId: string | null;
  readonly targetType: string;
  readonly targetId: string;
  readonly action: string;
  readonly correlationId: string;
  readonly reason: string;
  readonly previousValue: AuditValue;
  readonly newValue: AuditValue;
}

export interface AuthorizationBindingRepository {
  upsertClientInstallation(
    client: PoolClient,
    input: UpsertClientInstallationInput,
  ): Promise<ClientInstallation>;
  lockClientInstallation(
    client: PoolClient,
    installationId: string,
  ): Promise<ClientInstallation | null>;
  createAuthorizationCode(
    client: PoolClient,
    input: CreateAuthorizationCodeInput,
  ): Promise<AuthorizationCode>;
  lockAuthorizationCodeByDigest(
    client: PoolClient,
    codeDigest: string,
  ): Promise<AuthorizationCode | null>;
  consumeAuthorizationCode(
    client: PoolClient,
    input: ConsumeAuthorizationCodeInput,
  ): Promise<AuthorizationCode | null>;
}

export interface PlatformRepository {
  getRegistrationSettings(
    client: PoolClient,
  ): Promise<RegistrationSettings | null>;
  lockRegistrationSettings(
    client: PoolClient,
  ): Promise<RegistrationSettings | null>;
  updateRegistrationSettings(
    client: PoolClient,
    input: UpdateRegistrationSettingsInput,
  ): Promise<RegistrationSettings>;

  findAccountByNormalizedEmail(
    client: PoolClient,
    normalizedEmail: string,
  ): Promise<Account | null>;
  createAccount(
    client: PoolClient,
    input: CreateAccountInput,
  ): Promise<Account>;
  lockAccountById(
    client: PoolClient,
    accountId: string,
  ): Promise<Account | null>;
  updateAccountStatus(
    client: PoolClient,
    input: UpdateAccountStatusInput,
  ): Promise<Account>;
  markAccountEmailVerified(
    client: PoolClient,
    input: MarkAccountEmailVerifiedInput,
  ): Promise<Account>;

  createCredential(
    client: PoolClient,
    input: CreateCredentialInput,
  ): Promise<Credential>;
  findCredentialByAccountId(
    client: PoolClient,
    accountId: string,
  ): Promise<Credential | null>;
  updateCredential(
    client: PoolClient,
    input: UpdateCredentialInput,
  ): Promise<Credential>;

  createVerificationToken(
    client: PoolClient,
    input: CreateVerificationTokenInput,
  ): Promise<VerificationToken>;
  lockVerificationTokenByDigest(
    client: PoolClient,
    tokenDigest: string,
  ): Promise<VerificationToken | null>;
  consumeVerificationToken(
    client: PoolClient,
    input: ConsumeVerificationTokenInput,
  ): Promise<VerificationToken | null>;

  createInvitation(
    client: PoolClient,
    input: CreateInvitationInput,
  ): Promise<Invitation>;
  lockInvitationByDigest(
    client: PoolClient,
    tokenDigest: string,
  ): Promise<Invitation | null>;
  addInvitationGrants(
    client: PoolClient,
    input: AddInvitationGrantsInput,
  ): Promise<void>;
  listInvitationGrants(
    client: PoolClient,
    invitationId: string,
  ): Promise<readonly InvitationGrant[]>;
  incrementInvitationUse(
    client: PoolClient,
    input: IncrementInvitationUseInput,
  ): Promise<Invitation | null>;
  revokeInvitation(
    client: PoolClient,
    input: RevokeInvitationInput,
  ): Promise<Invitation | null>;

  findModulesByKeys(
    client: PoolClient,
    moduleKeys: readonly string[],
  ): Promise<readonly PlatformModule[]>;

  listAccountEntitlements(
    client: PoolClient,
    accountId: string,
  ): Promise<readonly AccountEntitlement[]>;
  upsertAccountEntitlement(
    client: PoolClient,
    input: UpsertAccountEntitlementInput,
  ): Promise<AccountEntitlement>;
  revokeAccountEntitlement(
    client: PoolClient,
    input: RevokeAccountEntitlementInput,
  ): Promise<AccountEntitlement | null>;

  listOperatorCapabilities(
    client: PoolClient,
    accountId: string,
  ): Promise<readonly string[]>;
  insertOperatorCapabilities(
    client: PoolClient,
    input: InsertOperatorCapabilitiesInput,
  ): Promise<void>;

  createSession(
    client: PoolClient,
    input: CreateSessionInput,
  ): Promise<AuthSession>;
  findSessionByDigest(
    client: PoolClient,
    sessionDigest: string,
  ): Promise<AuthSession | null>;
  lockSessionByDigest(
    client: PoolClient,
    sessionDigest: string,
  ): Promise<AuthSession | null>;
  findSessionById(
    client: PoolClient,
    sessionId: string,
  ): Promise<AuthSession | null>;
  listSessionsForAccount(
    client: PoolClient,
    accountId: string,
  ): Promise<readonly AuthSession[]>;
  revokeSession(
    client: PoolClient,
    input: RevokeSessionInput,
  ): Promise<AuthSession | null>;
  revokeSessionsForAccountByAudience(
    client: PoolClient,
    input: RevokeSessionsForAccountByAudienceInput,
  ): Promise<number>;
  revokeAllSessionsForAccount(
    client: PoolClient,
    input: RevokeAllSessionsInput,
  ): Promise<number>;

  insertAuditEvent(
    client: PoolClient,
    input: InsertAuditEventInput,
  ): Promise<AuditEvent>;
}
