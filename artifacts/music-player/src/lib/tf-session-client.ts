import { API_BASE, apiUrl } from "./api-config";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_32_BYTE_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

let csrfToken: string | null = null;

export interface TfBrowserSession {
  accountId: string;
  installationId: string;
  entitlements: string[];
  expiresAt: string;
  csrfToken: string;
}

export type TfApiErrorKind =
  | "unauthenticated"
  | "forbidden"
  | "unavailable"
  | "invalid"
  | "transport";

export class TfApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly kind: TfApiErrorKind,
  ) {
    super(code);
    this.name = "TfApiError";
  }
}

export interface TfAuthSecurityEvent {
  type: "invalidated" | "revalidate";
  error: TfApiError;
}

type TfAuthSecurityListener = (event: TfAuthSecurityEvent) => void;

const CORE_POLICY_ERROR_CODES = new Set([
  "module_access_denied",
  "policy_revoked",
  "policy_unavailable",
  "websocket_unavailable",
]);
const authSecurityListeners = new Set<TfAuthSecurityListener>();

export function subscribeTfAuthSecurityEvents(
  listener: TfAuthSecurityListener,
): () => void {
  authSecurityListeners.add(listener);
  let subscribed = true;

  return () => {
    if (!subscribed) return;
    subscribed = false;
    authSecurityListeners.delete(listener);
  };
}

export function reportTfAuthError(error: unknown): boolean {
  const apiError = toReportedTfApiError(error);
  if (apiError === null) return false;

  const type = apiError.kind === "unauthenticated"
    ? "invalidated"
    : CORE_POLICY_ERROR_CODES.has(apiError.code)
      ? "revalidate"
      : null;
  if (type === null) return false;

  clearTfSessionSecurityState();

  const event: TfAuthSecurityEvent = { type, error: apiError };
  for (const listener of [...authSecurityListeners]) {
    listener(event);
  }
  return true;
}

function toReportedTfApiError(error: unknown): TfApiError | null {
  if (error instanceof TfApiError) return error;
  if (!isRecord(error) || typeof error.status !== "number") return null;

  const data = isRecord(error.data) ? error.data : null;
  const code = typeof error.code === "string"
    ? error.code
    : data && typeof data.error === "string"
      ? data.error
      : null;

  if (error.status === 401) {
    return new TfApiError(401, code ?? "unauthorized", "unauthenticated");
  }
  if (error.status === 403 && code === "module_access_denied") {
    return new TfApiError(403, code, "forbidden");
  }
  if (error.status === 503 && code === "policy_unavailable") {
    return new TfApiError(503, code, "unavailable");
  }
  return null;
}

export function normalizeTfApiError(error: unknown): TfApiError {
  return error instanceof TfApiError
    ? error
    : new TfApiError(0, "transport_unavailable", "transport");
}

export function clearTfSessionSecurityState(): void {
  csrfToken = null;
}

export function tfRequestInit(init: RequestInit = {}): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);

  if (UNSAFE_METHODS.has(method)) {
    if (csrfToken === null) {
      throw new TfApiError(0, "csrf_unavailable", "unauthenticated");
    }
    headers.set("X-CSRF-Token", csrfToken);
  }

  return {
    ...init,
    method,
    credentials: "include",
    headers: Object.fromEntries(headers.entries()),
  };
}

export async function tfFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const requestInit = tfRequestInit(init);
  let response: Response;

  try {
    response = await fetch(apiUrl(path), requestInit);
  } catch (error) {
    throw normalizeTfApiError(error);
  }

  if (!response.ok) {
    const body = await parseJson(response).catch(() => undefined);
    const code = isRecord(body) && typeof body.error === "string"
      ? body.error
      : "invalid_response";
    const kind = response.status === 401
      ? "unauthenticated"
      : response.status === 403
        ? "forbidden"
        : response.status === 503
          ? "unavailable"
          : "invalid";
    const apiError = new TfApiError(response.status, code, kind);
    if (response.status === 401) {
      clearTfSessionSecurityState();
    }
    reportTfAuthError(apiError);
    throw apiError;
  }

  try {
    return await parseJson(response) as T;
  } catch (error) {
    throw normalizeTfApiError(error);
  }
}

export async function fetchTfSession(): Promise<TfBrowserSession> {
  const session = await tfFetch<unknown>("/auth/me");

  if (!isTfBrowserSession(session)) {
    clearTfSessionSecurityState();
    throw new TfApiError(200, "invalid_session", "invalid");
  }

  return session;
}

export function commitTfSessionSecurityState(session: TfBrowserSession): void {
  if (!isTfBrowserSession(session)) {
    clearTfSessionSecurityState();
    throw new TfApiError(200, "invalid_session", "invalid");
  }

  csrfToken = session.csrfToken;
}

export function startTfLogin(): void {
  window.location.assign(apiUrl("/auth/start"));
}

export async function logoutTfSession(): Promise<void> {
  await tfFetch<void>("/auth/logout", { method: "POST" });
}

export async function createWebSocketTicket(): Promise<string> {
  const response = await tfFetch<unknown>("/ws/tickets", { method: "POST" });

  if (!isRecord(response) || typeof response.ticket !== "string" || !TICKET_PATTERN.test(response.ticket)) {
    throw new TfApiError(201, "invalid_websocket_ticket", "invalid");
  }

  return response.ticket;
}

export function buildTfWebSocketUrl(ticket: string): string {
  const url = new URL(API_BASE, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = `ticket=${encodeURIComponent(ticket)}`;
  return url.toString();
}

async function parseJson(response: Response): Promise<unknown> {
  if (response.status === 204 || !response.headers.get("Content-Type")?.includes("application/json")) {
    return undefined;
  }

  return response.json();
}

function isTfBrowserSession(value: unknown): value is TfBrowserSession {
  const expiresAt = isRecord(value) && typeof value.expiresAt === "string"
    ? Date.parse(value.expiresAt)
    : Number.NaN;

  return isRecord(value)
    && typeof value.accountId === "string"
    && UUID_PATTERN.test(value.accountId)
    && typeof value.installationId === "string"
    && UUID_PATTERN.test(value.installationId)
    && Array.isArray(value.entitlements)
    && value.entitlements.every((entitlement) => typeof entitlement === "string")
    && typeof value.expiresAt === "string"
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now()
    && typeof value.csrfToken === "string"
    && CANONICAL_32_BYTE_BASE64URL_PATTERN.test(value.csrfToken);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
