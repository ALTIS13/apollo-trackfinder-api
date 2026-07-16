import type { PoolClient } from "pg";

import type {
  AuditEvent,
  InsertAuditEventInput,
  PlatformRepository,
} from "./repository.js";

export const AUDIT_ACTIONS = Object.freeze({
  registrationModeChanged: "registration.mode_changed",
  accountRegistered: "account.registered",
  accountEmailVerified: "account.email_verified",
  accountActivated: "account.activated",
  accountSuspended: "account.suspended",
});

export const SYSTEM_AUDIT_REASONS = Object.freeze({
  registration: "self_service_registration",
  emailVerification: "self_service_email_verification",
});

export function appendAuditEvent(
  repository: PlatformRepository,
  client: PoolClient,
  input: InsertAuditEventInput,
): Promise<AuditEvent> {
  return repository.insertAuditEvent(client, input);
}
