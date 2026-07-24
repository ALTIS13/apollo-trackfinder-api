import type { PolicyIntrospectionResponse } from "@workspace/platform-contract";
import type { Request, RequestHandler, Response } from "express";

import type { PlatformAuthClient } from "./platform-auth-client.js";
import type {
  TfSession,
  TfSessionStore,
  TfSessionObservation,
} from "./tf-session-store.js";

const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SNAPSHOT_MINIMUM_FRESHNESS_MS = 30_000;
const TF_SESSION_COOKIE_NAME = "__Host-apollo_tf";

export type TfCapability =
  | "tf.search"
  | "tf.integrations"
  | "tf.downloads"
  | "tf.collections";

export interface TfPrincipal {
  readonly accountId: string;
  readonly tfSessionId: string;
  readonly installationId: string;
  readonly entitlements: readonly string[];
  readonly sessionExpiresAt: string;
  readonly policyFreshUntil: string;
}

export interface TfRoutePolicy {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly pattern: RegExp;
  readonly capability: TfCapability;
  readonly live: boolean;
}

export interface TfProtectedRoute {
  readonly method: string;
  readonly path: string;
}

export interface TfPolicyDependencies {
  readonly platform: Pick<PlatformAuthClient, "introspect">;
  readonly sessionStore: Pick<
    TfSessionStore,
    "observeSession" | "refreshSession" | "revokeSession"
  >;
  readonly now?: () => number;
}

export const TF_ROUTE_POLICIES: readonly TfRoutePolicy[] = Object.freeze([
  {
    method: "POST",
    path: "/api/tracks/search",
    pattern: /^\/api\/tracks\/search$/,
    capability: "tf.search",
    live: false,
  },
  {
    method: "POST",
    path: "/api/tracks/batch-search",
    pattern: /^\/api\/tracks\/batch-search$/,
    capability: "tf.search",
    live: false,
  },
  {
    method: "GET",
    path: "/api/tracks/:id/stream",
    pattern: /^\/api\/tracks\/[^/]+\/stream$/,
    capability: "tf.search",
    live: false,
  },
  {
    method: "GET",
    path: "/api/tracks/:id/audio-stream",
    pattern: /^\/api\/tracks\/[^/]+\/audio-stream$/,
    capability: "tf.search",
    live: false,
  },
  {
    method: "GET",
    path: "/api/tracks/suggest",
    pattern: /^\/api\/tracks\/suggest$/,
    capability: "tf.search",
    live: false,
  },
  {
    method: "GET",
    path: "/api/tracks/lyrics",
    pattern: /^\/api\/tracks\/lyrics$/,
    capability: "tf.search",
    live: false,
  },
  {
    method: "GET",
    path: "/api/tracks/recent",
    pattern: /^\/api\/tracks\/recent$/,
    capability: "tf.collections",
    live: true,
  },
  {
    method: "POST",
    path: "/api/tracks/play",
    pattern: /^\/api\/tracks\/play$/,
    capability: "tf.collections",
    live: true,
  },
  {
    method: "GET",
    path: "/api/tracks/recommendations",
    pattern: /^\/api\/tracks\/recommendations$/,
    capability: "tf.collections",
    live: true,
  },
  {
    method: "GET",
    path: "/api/tracks/:id/download",
    pattern: /^\/api\/tracks\/[^/]+\/download$/,
    capability: "tf.downloads",
    live: true,
  },
  {
    method: "POST",
    path: "/api/tracks/download/queue",
    pattern: /^\/api\/tracks\/download\/queue$/,
    capability: "tf.downloads",
    live: true,
  },
  {
    method: "GET",
    path: "/api/tracks/download/jobs",
    pattern: /^\/api\/tracks\/download\/jobs$/,
    capability: "tf.downloads",
    live: true,
  },
  {
    method: "GET",
    path: "/api/tracks/download/status/:jobId",
    pattern: /^\/api\/tracks\/download\/status\/[^/]+$/,
    capability: "tf.downloads",
    live: true,
  },
  {
    method: "GET",
    path: "/api/tracks/download/file/:jobId",
    pattern: /^\/api\/tracks\/download\/file\/[^/]+$/,
    capability: "tf.downloads",
    live: true,
  },
  {
    method: "GET",
    path: "/api/spotify/login",
    pattern: /^\/api\/spotify\/login$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/spotify/callback",
    pattern: /^\/api\/spotify\/callback$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/spotify/status",
    pattern: /^\/api\/spotify\/status$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "POST",
    path: "/api/spotify/logout",
    pattern: /^\/api\/spotify\/logout$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/spotify/liked",
    pattern: /^\/api\/spotify\/liked$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/spotify/liked-all",
    pattern: /^\/api\/spotify\/liked-all$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/spotify/playlists",
    pattern: /^\/api\/spotify\/playlists$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/spotify/playlists/:playlistId/tracks",
    pattern: /^\/api\/spotify\/playlists\/[^/]+\/tracks$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/spotify/top-tracks",
    pattern: /^\/api\/spotify\/top-tracks$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "POST",
    path: "/api/yandex/token",
    pattern: /^\/api\/yandex\/token$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/yandex/status",
    pattern: /^\/api\/yandex\/status$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "POST",
    path: "/api/yandex/logout",
    pattern: /^\/api\/yandex\/logout$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/yandex/liked",
    pattern: /^\/api\/yandex\/liked$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/yandex/playlists",
    pattern: /^\/api\/yandex\/playlists$/,
    capability: "tf.integrations",
    live: true,
  },
  {
    method: "GET",
    path: "/api/yandex/playlists/:uid/:kind/tracks",
    pattern: /^\/api\/yandex\/playlists\/[^/]+\/[^/]+\/tracks$/,
    capability: "tf.integrations",
    live: true,
  },
]);

function pathWithoutQuery(path: string): string {
  const queryIndex = path.indexOf("?");
  return queryIndex < 0 ? path : path.slice(0, queryIndex);
}

function matchingPolicies(
  method: string,
  path: string,
  policies: readonly TfRoutePolicy[] = TF_ROUTE_POLICIES,
): TfRoutePolicy[] {
  const canonicalMethod = method.toUpperCase();
  const canonicalPath = pathWithoutQuery(path);
  return policies.filter(
    (policy) =>
      policy.method === canonicalMethod && policy.pattern.test(canonicalPath),
  );
}

export function requiredPolicyForRequest(
  method: string,
  path: string,
): TfRoutePolicy | null {
  const matches = matchingPolicies(method, path);
  return matches.length === 1 ? matches[0]! : null;
}

export function assertProtectedRouteCoverage(
  discoveredRoutes: readonly TfProtectedRoute[],
  policies: readonly TfRoutePolicy[] = TF_ROUTE_POLICIES,
): void {
  for (const route of discoveredRoutes) {
    if (matchingPolicies(route.method, route.path, policies).length !== 1) {
      throw new Error("protected route policy coverage mismatch");
    }
  }
  for (const policy of policies) {
    const matches = discoveredRoutes.filter(
      (route) =>
        route.method.toUpperCase() === policy.method &&
        policy.pattern.test(route.path),
    );
    if (matches.length !== 1) {
      throw new Error("protected route policy coverage mismatch");
    }
  }
}

function cookieValue(request: Request): string | null {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  if (cookies === undefined) return null;
  const descriptor = Object.getOwnPropertyDescriptor(
    cookies,
    TF_SESSION_COOKIE_NAME,
  );
  return descriptor?.get === undefined && typeof descriptor?.value === "string"
    ? descriptor.value
    : null;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid policy timestamp");
  return parsed;
}

function sendUnauthorized(response: Response): void {
  response.status(401).json({ error: "unauthorized" });
}

function sendPolicyUnavailable(response: Response): void {
  response.status(503).json({ error: "policy_unavailable" });
}

function exactRefreshedBinding(
  observation: TfSessionObservation,
  introspection: Extract<PolicyIntrospectionResponse, { active: true }>,
  refreshed: TfSession,
  now: number,
): boolean {
  return (
    introspection.accountId === observation.session.accountId &&
    introspection.sessionId === observation.session.platformSessionId &&
    introspection.installationId === observation.session.installationId &&
    introspection.accountStatus === "active" &&
    timestamp(introspection.expiresAt) > now &&
    refreshed.id === observation.session.id &&
    refreshed.accountId === observation.session.accountId &&
    refreshed.platformSessionId === observation.session.platformSessionId &&
    refreshed.installationId === observation.session.installationId &&
    timestamp(refreshed.expiresAt) > now &&
    timestamp(refreshed.assertionExpiresAt) > now
  );
}

function principalFrom(session: TfSession): TfPrincipal {
  return Object.freeze({
    accountId: session.accountId,
    tfSessionId: session.id,
    installationId: session.installationId,
    entitlements: Object.freeze([...session.entitlements]),
    sessionExpiresAt: session.expiresAt,
    policyFreshUntil: session.assertionExpiresAt,
  });
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("invalid clock");
  }
  return value;
}

export function requireTfCapability(
  dependencies: TfPolicyDependencies,
): RequestHandler {
  return async (request, response, next) => {
    if (request.tfPrincipal !== undefined) {
      sendPolicyUnavailable(response);
      return;
    }
    const policy = requiredPolicyForRequest(
      request.method,
      request.originalUrl,
    );
    if (policy === null) {
      sendPolicyUnavailable(response);
      return;
    }
    const handle = cookieValue(request);
    if (handle === null || !OPAQUE_PATTERN.test(handle)) {
      sendUnauthorized(response);
      return;
    }

    try {
      const now = dependencies.now ?? Date.now;
      const observation =
        await dependencies.sessionStore.observeSession(handle);
      if (observation === null) {
        sendUnauthorized(response);
        return;
      }
      const decisionTime = checkedNow(now);
      if (timestamp(observation.session.expiresAt) <= decisionTime) {
        sendUnauthorized(response);
        return;
      }

      let authorizedSession = observation.session;
      const snapshotFresh =
        timestamp(observation.session.assertionExpiresAt) - decisionTime >
        SNAPSHOT_MINIMUM_FRESHNESS_MS;
      if (policy.live || !snapshotFresh) {
        const introspection = await dependencies.platform.introspect({
          accountId: observation.session.accountId,
          sessionId: observation.session.platformSessionId,
          installationId: observation.session.installationId,
          audience: "apollo-tf",
        });
        if (!introspection.active) {
          await dependencies.sessionStore.revokeSession(handle);
          sendUnauthorized(response);
          return;
        }
        if (
          introspection.accountId !== observation.session.accountId ||
          introspection.sessionId !== observation.session.platformSessionId ||
          introspection.installationId !== observation.session.installationId
        ) {
          sendPolicyUnavailable(response);
          return;
        }
        const refreshed = await dependencies.sessionStore.refreshSession(
          handle,
          observation.revision,
          introspection,
        );
        const refreshedTime = checkedNow(now);
        if (
          refreshed === null ||
          !exactRefreshedBinding(
            observation,
            introspection,
            refreshed,
            refreshedTime,
          )
        ) {
          sendPolicyUnavailable(response);
          return;
        }
        authorizedSession = refreshed;
      }

      if (!authorizedSession.entitlements.includes(policy.capability)) {
        response.status(403).json({ error: "module_access_denied" });
        return;
      }
      request.tfPrincipal = principalFrom(authorizedSession);
      next();
    } catch {
      sendPolicyUnavailable(response);
    }
  };
}
