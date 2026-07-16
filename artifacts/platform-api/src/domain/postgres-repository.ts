import type {
  AccountStatus,
  RegistrationMode,
} from "@workspace/platform-contract";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import type {
  Account,
  AccountEntitlement,
  AddInvitationGrantsInput,
  AuditEvent,
  AuditValue,
  AuthSession,
  ConsumeVerificationTokenInput,
  CreateAccountInput,
  CreateCredentialInput,
  CreateInvitationInput,
  CreateSessionInput,
  CreateVerificationTokenInput,
  Credential,
  IncrementInvitationUseInput,
  InsertAuditEventInput,
  Invitation,
  InvitationGrant,
  MarkAccountEmailVerifiedInput,
  PlatformModule,
  PlatformRepository,
  RegistrationSettings,
  RevokeAccountEntitlementInput,
  RevokeAllSessionsInput,
  RevokeInvitationInput,
  RevokeSessionInput,
  UpdateAccountStatusInput,
  UpdateCredentialInput,
  UpdateRegistrationSettingsInput,
  UpsertAccountEntitlementInput,
  VerificationToken,
} from "./repository.js";

export type RepositoryErrorCode =
  | "conflict"
  | "constraint_violation"
  | "reference_not_found"
  | "storage_unavailable";

export interface RepositoryError {
  readonly code: RepositoryErrorCode;
  readonly message: string;
}

const REPOSITORY_ERROR_MESSAGES: Readonly<Record<RepositoryErrorCode, string>> =
  Object.freeze({
    conflict: "The requested resource conflicts with existing data.",
    constraint_violation: "The requested operation violates a data constraint.",
    reference_not_found: "A referenced resource was not found.",
    storage_unavailable: "The storage operation could not be completed.",
  });

export function mapRepositoryError(error: unknown): RepositoryError {
  let sqlState: string | undefined;
  if (typeof error === "object" && error !== null && "code" in error) {
    const candidate = (error as { readonly code?: unknown }).code;
    if (typeof candidate === "string") {
      sqlState = candidate;
    }
  }

  const code: RepositoryErrorCode =
    sqlState === "23505"
      ? "conflict"
      : sqlState === "23514"
        ? "constraint_violation"
        : sqlState === "23503"
          ? "reference_not_found"
          : "storage_unavailable";

  return Object.freeze({ code, message: REPOSITORY_ERROR_MESSAGES[code] });
}

async function execute<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
  try {
    return await client.query<Row>(text, [...values]);
  } catch (error) {
    throw mapRepositoryError(error);
  }
}

async function setPreAuthEmailContext(
  client: PoolClient,
  normalizedEmail: string,
): Promise<void> {
  await execute<QueryResultRow>(
    client,
    "select set_config('app.pre_auth_email', $1, true)",
    [normalizedEmail],
  );
}

async function setVerificationDigestContext(
  client: PoolClient,
  tokenDigest: string,
): Promise<void> {
  await execute<QueryResultRow>(
    client,
    "select set_config('app.verification_digest', $1, true)",
    [tokenDigest],
  );
}

async function setSessionDigestContext(
  client: PoolClient,
  sessionDigest: string,
): Promise<void> {
  await execute<QueryResultRow>(
    client,
    "select set_config('app.session_digest', $1, true)",
    [sessionDigest],
  );
}

function requireRow<Row>(rows: readonly Row[]): Row {
  const row = rows[0];
  if (row === undefined) {
    throw mapRepositoryError(undefined);
  }
  return row;
}

interface RegistrationSettingsRow extends QueryResultRow {
  readonly id: string;
  readonly mode: string;
  readonly revision: string | number;
  readonly updated_by_account_id: string | null;
  readonly updated_at: Date;
}

interface AccountRow extends QueryResultRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly status: string;
  readonly email_verified_at: Date | null;
  readonly activated_at: Date | null;
  readonly suspended_at: Date | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CredentialRow extends QueryResultRow {
  readonly account_id: string;
  readonly password_hash: string;
  readonly password_changed_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface VerificationTokenRow extends QueryResultRow {
  readonly id: string;
  readonly account_id: string;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly created_at: Date;
}

interface InvitationRow extends QueryResultRow {
  readonly id: string;
  readonly email: string | null;
  readonly expires_at: Date;
  readonly uses_limit: number;
  readonly uses_count: number;
  readonly revoked_at: Date | null;
  readonly created_by_account_id: string | null;
  readonly reason: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface InvitationGrantRow extends QueryResultRow {
  readonly invitation_id: string;
  readonly module_id: string;
  readonly module_key: string;
}

interface PlatformModuleRow extends QueryResultRow {
  readonly id: string;
  readonly module_key: string;
  readonly product: string;
  readonly display_name: string;
  readonly state: "active" | "disabled";
  readonly description: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AccountEntitlementRow extends QueryResultRow {
  readonly id: string;
  readonly account_id: string;
  readonly module_id: string;
  readonly module_key: string;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly source: string;
  readonly granted_by_account_id: string | null;
  readonly reason: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CapabilityRow extends QueryResultRow {
  readonly capability: string;
}

interface SessionRow extends QueryResultRow {
  readonly id: string;
  readonly account_id: string;
  readonly installation_id: string | null;
  readonly audience: string;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
  readonly last_seen_at: Date;
}

interface AuditEventRow extends QueryResultRow {
  readonly id: string;
  readonly actor_account_id: string | null;
  readonly target_type: string;
  readonly target_id: string;
  readonly action: string;
  readonly correlation_id: string;
  readonly reason: string;
  readonly previous_value: AuditValue;
  readonly new_value: AuditValue;
  readonly occurred_at: Date;
}

function mapRegistrationSettings(
  row: RegistrationSettingsRow,
): RegistrationSettings {
  return {
    id: row.id,
    mode: row.mode as RegistrationMode,
    revision: Number(row.revision),
    updatedByAccountId: row.updated_by_account_id,
    updatedAt: row.updated_at,
  };
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status as AccountStatus,
    emailVerifiedAt: row.email_verified_at,
    activatedAt: row.activated_at,
    suspendedAt: row.suspended_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCredential(row: CredentialRow): Credential {
  return {
    accountId: row.account_id,
    passwordHash: row.password_hash,
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVerificationToken(row: VerificationTokenRow): VerificationToken {
  return {
    id: row.id,
    accountId: row.account_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function mapInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    expiresAt: row.expires_at,
    usesLimit: row.uses_limit,
    usesCount: row.uses_count,
    revokedAt: row.revoked_at,
    createdByAccountId: row.created_by_account_id,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInvitationGrant(row: InvitationGrantRow): InvitationGrant {
  return {
    invitationId: row.invitation_id,
    moduleId: row.module_id,
    moduleKey: row.module_key,
  };
}

function mapPlatformModule(row: PlatformModuleRow): PlatformModule {
  return {
    id: row.id,
    moduleKey: row.module_key,
    product: row.product,
    displayName: row.display_name,
    state: row.state,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAccountEntitlement(row: AccountEntitlementRow): AccountEntitlement {
  return {
    id: row.id,
    accountId: row.account_id,
    moduleId: row.module_id,
    moduleKey: row.module_key,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    source: row.source,
    grantedByAccountId: row.granted_by_account_id,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    accountId: row.account_id,
    installationId: row.installation_id,
    audience: row.audience,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    actorAccountId: row.actor_account_id,
    targetType: row.target_type,
    targetId: row.target_id,
    action: row.action,
    correlationId: row.correlation_id,
    reason: row.reason,
    previousValue: row.previous_value,
    newValue: row.new_value,
    occurredAt: row.occurred_at,
  };
}

export class PostgresPlatformRepository implements PlatformRepository {
  async getRegistrationSettings(
    client: PoolClient,
  ): Promise<RegistrationSettings | null> {
    const result = await execute<RegistrationSettingsRow>(
      client,
      `select id, mode, revision, updated_by_account_id, updated_at
       from apollo_platform.registration_settings
       where singleton = true`,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRegistrationSettings(row);
  }

  async lockRegistrationSettings(
    client: PoolClient,
  ): Promise<RegistrationSettings | null> {
    const result = await execute<RegistrationSettingsRow>(
      client,
      `select id, mode, revision, updated_by_account_id, updated_at
       from apollo_platform.registration_settings
       where singleton = true
       for update`,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRegistrationSettings(row);
  }

  async updateRegistrationSettings(
    client: PoolClient,
    input: UpdateRegistrationSettingsInput,
  ): Promise<RegistrationSettings> {
    const result = await execute<RegistrationSettingsRow>(
      client,
      `update apollo_platform.registration_settings
       set mode = $1,
           revision = revision + 1,
           updated_by_account_id = $2,
           updated_at = now()
       where singleton = true
       returning id, mode, revision, updated_by_account_id, updated_at`,
      [input.mode, input.updatedByAccountId],
    );
    return mapRegistrationSettings(requireRow(result.rows));
  }

  async findAccountByNormalizedEmail(
    client: PoolClient,
    normalizedEmail: string,
  ): Promise<Account | null> {
    await setPreAuthEmailContext(client, normalizedEmail);
    const result = await execute<AccountRow>(
      client,
      `select id, email, display_name, status, email_verified_at,
              activated_at, suspended_at, deleted_at, created_at, updated_at
       from apollo_platform.accounts
       where email = $1`,
      [normalizedEmail],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAccount(row);
  }

  async createAccount(
    client: PoolClient,
    input: CreateAccountInput,
  ): Promise<Account> {
    await setPreAuthEmailContext(client, input.normalizedEmail);
    const result = await execute<AccountRow>(
      client,
      `insert into apollo_platform.accounts (email, display_name)
       values ($1, $2)
       returning id, email, display_name, status, email_verified_at,
                 activated_at, suspended_at, deleted_at, created_at, updated_at`,
      [input.normalizedEmail, input.displayName],
    );
    return mapAccount(requireRow(result.rows));
  }

  async lockAccountById(
    client: PoolClient,
    accountId: string,
  ): Promise<Account | null> {
    const result = await execute<AccountRow>(
      client,
      `select id, email, display_name, status, email_verified_at,
              activated_at, suspended_at, deleted_at, created_at, updated_at
       from apollo_platform.accounts
       where id = $1
       for update`,
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAccount(row);
  }

  async updateAccountStatus(
    client: PoolClient,
    input: UpdateAccountStatusInput,
  ): Promise<Account> {
    const result = await execute<AccountRow>(
      client,
      `update apollo_platform.accounts
       set status = $2,
           activated_at = case
             when $2 = 'active' then coalesce(activated_at, $3)
             else activated_at
           end,
           suspended_at = case
             when $2 = 'suspended' then $3
             else suspended_at
           end,
           deleted_at = case
             when $2 = 'deleted' then $3
             else deleted_at
           end,
           updated_at = $3
       where id = $1
       returning id, email, display_name, status, email_verified_at,
                 activated_at, suspended_at, deleted_at, created_at, updated_at`,
      [input.accountId, input.status, input.changedAt],
    );
    return mapAccount(requireRow(result.rows));
  }

  async markAccountEmailVerified(
    client: PoolClient,
    input: MarkAccountEmailVerifiedInput,
  ): Promise<Account> {
    const result = await execute<AccountRow>(
      client,
      `update apollo_platform.accounts
       set email_verified_at = coalesce(email_verified_at, $2),
           updated_at = $2
       where id = $1
       returning id, email, display_name, status, email_verified_at,
                 activated_at, suspended_at, deleted_at, created_at, updated_at`,
      [input.accountId, input.verifiedAt],
    );
    return mapAccount(requireRow(result.rows));
  }

  async createCredential(
    client: PoolClient,
    input: CreateCredentialInput,
  ): Promise<Credential> {
    const result = await execute<CredentialRow>(
      client,
      `insert into apollo_platform.credentials
         (account_id, password_hash, password_changed_at)
       values ($1, $2, $3)
       returning account_id, password_hash, password_changed_at,
                 created_at, updated_at`,
      [input.accountId, input.passwordHash, input.passwordChangedAt],
    );
    return mapCredential(requireRow(result.rows));
  }

  async findCredentialByAccountId(
    client: PoolClient,
    accountId: string,
  ): Promise<Credential | null> {
    const result = await execute<CredentialRow>(
      client,
      `select account_id, password_hash, password_changed_at,
              created_at, updated_at
       from apollo_platform.credentials
       where account_id = $1`,
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapCredential(row);
  }

  async updateCredential(
    client: PoolClient,
    input: UpdateCredentialInput,
  ): Promise<Credential> {
    const result = await execute<CredentialRow>(
      client,
      `update apollo_platform.credentials
       set password_hash = $2,
           password_changed_at = $3,
           updated_at = $3
       where account_id = $1
       returning account_id, password_hash, password_changed_at,
                 created_at, updated_at`,
      [input.accountId, input.passwordHash, input.passwordChangedAt],
    );
    return mapCredential(requireRow(result.rows));
  }

  async createVerificationToken(
    client: PoolClient,
    input: CreateVerificationTokenInput,
  ): Promise<VerificationToken> {
    const result = await execute<VerificationTokenRow>(
      client,
      `insert into apollo_platform.email_verification_tokens
         (account_id, token_digest, expires_at)
       values ($1, $2, $3)
       returning id, account_id, expires_at, consumed_at, created_at`,
      [input.accountId, input.tokenDigest, input.expiresAt],
    );
    return mapVerificationToken(requireRow(result.rows));
  }

  async lockVerificationTokenByDigest(
    client: PoolClient,
    tokenDigest: string,
  ): Promise<VerificationToken | null> {
    await setVerificationDigestContext(client, tokenDigest);
    const result = await execute<VerificationTokenRow>(
      client,
      `select id, account_id, expires_at, consumed_at, created_at
       from apollo_platform.email_verification_tokens
       where token_digest = $1
       for update`,
      [tokenDigest],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapVerificationToken(row);
  }

  async consumeVerificationToken(
    client: PoolClient,
    input: ConsumeVerificationTokenInput,
  ): Promise<VerificationToken | null> {
    const result = await execute<VerificationTokenRow>(
      client,
      `update apollo_platform.email_verification_tokens
       set consumed_at = $2
       where id = $1 and consumed_at is null
       returning id, account_id, expires_at, consumed_at, created_at`,
      [input.verificationTokenId, input.consumedAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapVerificationToken(row);
  }

  async createInvitation(
    client: PoolClient,
    input: CreateInvitationInput,
  ): Promise<Invitation> {
    const result = await execute<InvitationRow>(
      client,
      `insert into apollo_platform.invitations
         (token_digest, email, expires_at, uses_limit,
          created_by_account_id, reason)
       values ($1, $2, $3, $4, $5, $6)
       returning id, email, expires_at, uses_limit, uses_count, revoked_at,
                 created_by_account_id, reason, created_at, updated_at`,
      [
        input.tokenDigest,
        input.normalizedEmail,
        input.expiresAt,
        input.usesLimit,
        input.createdByAccountId,
        input.reason,
      ],
    );
    return mapInvitation(requireRow(result.rows));
  }

  async lockInvitationByDigest(
    client: PoolClient,
    tokenDigest: string,
  ): Promise<Invitation | null> {
    const result = await execute<InvitationRow>(
      client,
      `select id, email, expires_at, uses_limit, uses_count, revoked_at,
              created_by_account_id, reason, created_at, updated_at
       from apollo_platform.invitations
       where token_digest = $1
       for update`,
      [tokenDigest],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapInvitation(row);
  }

  async addInvitationGrants(
    client: PoolClient,
    input: AddInvitationGrantsInput,
  ): Promise<void> {
    await execute<QueryResultRow>(
      client,
      `insert into apollo_platform.invitation_module_grants
         (invitation_id, module_id)
       select $1, grant.module_id
       from unnest($2::uuid[]) as grant(module_id)
       on conflict (invitation_id, module_id) do nothing`,
      [input.invitationId, input.moduleIds],
    );
  }

  async listInvitationGrants(
    client: PoolClient,
    invitationId: string,
  ): Promise<readonly InvitationGrant[]> {
    const result = await execute<InvitationGrantRow>(
      client,
      `select grant.invitation_id, grant.module_id, module.module_key
       from apollo_platform.invitation_module_grants as grant
       join apollo_platform.modules as module on module.id = grant.module_id
       where grant.invitation_id = $1
       order by module.module_key`,
      [invitationId],
    );
    return result.rows.map(mapInvitationGrant);
  }

  async incrementInvitationUse(
    client: PoolClient,
    input: IncrementInvitationUseInput,
  ): Promise<Invitation | null> {
    const result = await execute<InvitationRow>(
      client,
      `update apollo_platform.invitations
       set uses_count = uses_count + 1,
           updated_at = $2
       where id = $1 and uses_count < uses_limit
       returning id, email, expires_at, uses_limit, uses_count, revoked_at,
                 created_by_account_id, reason, created_at, updated_at`,
      [input.invitationId, input.usedAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapInvitation(row);
  }

  async revokeInvitation(
    client: PoolClient,
    input: RevokeInvitationInput,
  ): Promise<Invitation | null> {
    const result = await execute<InvitationRow>(
      client,
      `update apollo_platform.invitations
       set revoked_at = coalesce(revoked_at, $2),
           updated_at = $2
       where id = $1
       returning id, email, expires_at, uses_limit, uses_count, revoked_at,
                 created_by_account_id, reason, created_at, updated_at`,
      [input.invitationId, input.revokedAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapInvitation(row);
  }

  async findModulesByKeys(
    client: PoolClient,
    moduleKeys: readonly string[],
  ): Promise<readonly PlatformModule[]> {
    const result = await execute<PlatformModuleRow>(
      client,
      `select id, module_key, product, display_name, state, description,
              created_at, updated_at
       from apollo_platform.modules
       where module_key = any($1::text[])
       order by module_key`,
      [moduleKeys],
    );
    return result.rows.map(mapPlatformModule);
  }

  async listAccountEntitlements(
    client: PoolClient,
    accountId: string,
  ): Promise<readonly AccountEntitlement[]> {
    const result = await execute<AccountEntitlementRow>(
      client,
      `select entitlement.id, entitlement.account_id, entitlement.module_id,
              module.module_key, entitlement.expires_at,
              entitlement.revoked_at, entitlement.source,
              entitlement.granted_by_account_id, entitlement.reason,
              entitlement.created_at, entitlement.updated_at
       from apollo_platform.account_module_entitlements as entitlement
       join apollo_platform.modules as module on module.id = entitlement.module_id
       where entitlement.account_id = $1
       order by module.module_key`,
      [accountId],
    );
    return result.rows.map(mapAccountEntitlement);
  }

  async upsertAccountEntitlement(
    client: PoolClient,
    input: UpsertAccountEntitlementInput,
  ): Promise<AccountEntitlement> {
    const result = await execute<AccountEntitlementRow>(
      client,
      `with upserted as (
         insert into apollo_platform.account_module_entitlements
           (account_id, module_id, expires_at, source,
            granted_by_account_id, reason)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (account_id, module_id) do update
         set expires_at = excluded.expires_at,
             revoked_at = null,
             source = excluded.source,
             granted_by_account_id = excluded.granted_by_account_id,
             reason = excluded.reason,
             updated_at = now()
         returning id, account_id, module_id, expires_at, revoked_at, source,
                   granted_by_account_id, reason, created_at, updated_at
       )
       select upserted.id, upserted.account_id, upserted.module_id,
              module.module_key, upserted.expires_at, upserted.revoked_at,
              upserted.source, upserted.granted_by_account_id,
              upserted.reason, upserted.created_at, upserted.updated_at
       from upserted
       join apollo_platform.modules as module on module.id = upserted.module_id`,
      [
        input.accountId,
        input.moduleId,
        input.expiresAt,
        input.source,
        input.grantedByAccountId,
        input.reason,
      ],
    );
    return mapAccountEntitlement(requireRow(result.rows));
  }

  async revokeAccountEntitlement(
    client: PoolClient,
    input: RevokeAccountEntitlementInput,
  ): Promise<AccountEntitlement | null> {
    const result = await execute<AccountEntitlementRow>(
      client,
      `update apollo_platform.account_module_entitlements as entitlement
       set revoked_at = coalesce(entitlement.revoked_at, $3),
           reason = $4,
           updated_at = $3
       from apollo_platform.modules as module
       where entitlement.account_id = $1
         and entitlement.module_id = $2
         and module.id = entitlement.module_id
       returning entitlement.id, entitlement.account_id,
                 entitlement.module_id, module.module_key,
                 entitlement.expires_at, entitlement.revoked_at,
                 entitlement.source, entitlement.granted_by_account_id,
                 entitlement.reason, entitlement.created_at,
                 entitlement.updated_at`,
      [input.accountId, input.moduleId, input.revokedAt, input.reason],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAccountEntitlement(row);
  }

  async listOperatorCapabilities(
    client: PoolClient,
    accountId: string,
  ): Promise<readonly string[]> {
    const result = await execute<CapabilityRow>(
      client,
      `select capability
       from apollo_platform.operator_roles
       where account_id = $1 and revoked_at is null
       order by capability`,
      [accountId],
    );
    return result.rows.map((row) => row.capability);
  }

  async createSession(
    client: PoolClient,
    input: CreateSessionInput,
  ): Promise<AuthSession> {
    const result = await execute<SessionRow>(
      client,
      `insert into apollo_platform.auth_sessions
         (account_id, installation_id, session_digest, audience, expires_at)
       values ($1, $2, $3, $4, $5)
       returning id, account_id, installation_id, audience, expires_at,
                 revoked_at, created_at, last_seen_at`,
      [
        input.accountId,
        input.installationId,
        input.sessionDigest,
        input.audience,
        input.expiresAt,
      ],
    );
    return mapSession(requireRow(result.rows));
  }

  async findSessionByDigest(
    client: PoolClient,
    sessionDigest: string,
  ): Promise<AuthSession | null> {
    await setSessionDigestContext(client, sessionDigest);
    const result = await execute<SessionRow>(
      client,
      `select id, account_id, installation_id, audience, expires_at,
              revoked_at, created_at, last_seen_at
       from apollo_platform.auth_sessions
       where session_digest = $1`,
      [sessionDigest],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapSession(row);
  }

  async listSessionsForAccount(
    client: PoolClient,
    accountId: string,
  ): Promise<readonly AuthSession[]> {
    const result = await execute<SessionRow>(
      client,
      `select id, account_id, installation_id, audience, expires_at,
              revoked_at, created_at, last_seen_at
       from apollo_platform.auth_sessions
       where account_id = $1
       order by created_at desc`,
      [accountId],
    );
    return result.rows.map(mapSession);
  }

  async revokeSession(
    client: PoolClient,
    input: RevokeSessionInput,
  ): Promise<AuthSession | null> {
    const result = await execute<SessionRow>(
      client,
      `update apollo_platform.auth_sessions
       set revoked_at = coalesce(revoked_at, $2)
       where id = $1
       returning id, account_id, installation_id, audience, expires_at,
                 revoked_at, created_at, last_seen_at`,
      [input.sessionId, input.revokedAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapSession(row);
  }

  async revokeAllSessionsForAccount(
    client: PoolClient,
    input: RevokeAllSessionsInput,
  ): Promise<number> {
    const result = await execute<QueryResultRow>(
      client,
      `update apollo_platform.auth_sessions
       set revoked_at = $2
       where account_id = $1 and revoked_at is null`,
      [input.accountId, input.revokedAt],
    );
    return result.rowCount ?? 0;
  }

  async insertAuditEvent(
    client: PoolClient,
    input: InsertAuditEventInput,
  ): Promise<AuditEvent> {
    const result = await execute<AuditEventRow>(
      client,
      `insert into apollo_platform.audit_events
         (actor_account_id, target_type, target_id, action, correlation_id,
          reason, previous_value, new_value)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, actor_account_id, target_type, target_id, action,
                 correlation_id, reason, previous_value, new_value, occurred_at`,
      [
        input.actorAccountId,
        input.targetType,
        input.targetId,
        input.action,
        input.correlationId,
        input.reason,
        input.previousValue,
        input.newValue,
      ],
    );
    return mapAuditEvent(requireRow(result.rows));
  }
}
