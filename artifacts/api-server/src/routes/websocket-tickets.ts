import { Router, type IRouter, type Request } from "express";

import {
  TfSessionNotFoundError,
  type TfSessionStore,
} from "../lib/tf-session-store.js";

const TF_SESSION_COOKIE_NAME = "__Host-apollo_tf";
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface WebSocketTicketRouteDependencies {
  readonly issueWebSocketTicket: Pick<
    TfSessionStore,
    "issueWebSocketTicket"
  >["issueWebSocketTicket"];
}

function canonicalOpaque(value: string): boolean {
  if (!OPAQUE_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}

function sessionHandle(request: Request): string | null {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  if (cookies === undefined) return null;
  const descriptor = Object.getOwnPropertyDescriptor(
    cookies,
    TF_SESSION_COOKIE_NAME,
  );
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    typeof descriptor.value !== "string" ||
    !canonicalOpaque(descriptor.value)
  ) {
    return null;
  }
  return descriptor.value;
}

function hasExactEmptyInput(request: Request): boolean {
  if (request.originalUrl.includes("?")) return false;
  if (request.headers["transfer-encoding"] !== undefined) return false;
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && contentLength !== "0") return false;
  const body = request.body as unknown;
  if (body === undefined) return true;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  try {
    return Object.keys(body).length === 0;
  } catch {
    return false;
  }
}

export function createWebSocketTicketRouter(
  dependencies: WebSocketTicketRouteDependencies,
): IRouter {
  const router: IRouter = Router();

  router.post("/ws/tickets", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!hasExactEmptyInput(request)) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    const handle = sessionHandle(request);
    if (handle === null) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const ticket = await dependencies.issueWebSocketTicket(handle);
      if (!canonicalOpaque(ticket)) {
        throw new Error("invalid ticket");
      }
      response.status(201).json({ ticket });
    } catch (error) {
      if (error instanceof TfSessionNotFoundError) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      response.status(503).json({ error: "policy_unavailable" });
    }
  });

  return router;
}
