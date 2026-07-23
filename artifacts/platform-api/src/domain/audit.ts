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
  invitationCreated: "invitation.created",
  invitationRedeemed: "invitation.redeemed",
  invitationRevoked: "invitation.revoked",
  operatorBootstrapCompleted: "operator.bootstrap_completed",
  operatorSessionCreated: "operator.session_created",
  operatorSessionRevoked: "operator.session_revoked",
  userSessionCreated: "user.session_created",
  userSessionRevoked: "user.session_revoked",
  entitlementGranted: "entitlement.granted",
  entitlementRevoked: "entitlement.revoked",
  authorizationCodeIssued: "authorization.code_issued",
  authorizationCodeExchanged: "authorization.code_exchanged",
});

export const SYSTEM_AUDIT_REASONS = Object.freeze({
  registration: "self_service_registration",
  emailVerification: "self_service_email_verification",
  invitationRedemption: "invitation_redemption",
  operatorLogin: "operator_login",
  operatorLogout: "operator_logout",
  userLogin: "user_login",
  userLogout: "user_logout",
  oauthAuthorizationIssue: "oauth_authorization_issue",
  oauthAuthorizationExchange: "oauth_authorization_exchange",
});

export function appendAuditEvent(
  repository: Pick<PlatformRepository, "insertAuditEvent">,
  client: PoolClient,
  input: InsertAuditEventInput,
): Promise<AuditEvent> {
  return repository.insertAuditEvent(client, input);
}
