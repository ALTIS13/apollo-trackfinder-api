import { API_BASE, apiUrl } from "./api-config";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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

  return { ...init, method, credentials: "include", headers };
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
    if (response.status === 401) {
      clearTfSessionSecurityState();
    }
    throw new TfApiError(response.status, code, kind);
  }

  try {
    return await parseJson(response) as T;
  } catch (error) {
    throw normalizeTfApiError(error);
  }
}

export async function loadTfSession(): Promise<TfBrowserSession> {
  const session = await tfFetch<unknown>("/auth/me");

  if (!isTfBrowserSession(session)) {
    clearTfSessionSecurityState();
    throw new TfApiError(200, "invalid_session", "invalid");
  }

  csrfToken = session.csrfToken;
  return session;
}

export function startTfLogin(): void {
  window.location.assign(apiUrl("/auth/start"));
}

export async function logoutTfSession(): Promise<void> {
  try {
    await tfFetch<void>("/auth/logout", { method: "POST" });
  } finally {
    clearTfSessionSecurityState();
  }
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
  return isRecord(value)
    && typeof value.accountId === "string"
    && typeof value.installationId === "string"
    && Array.isArray(value.entitlements)
    && value.entitlements.every((entitlement) => typeof entitlement === "string")
    && typeof value.expiresAt === "string"
    && typeof value.csrfToken === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
