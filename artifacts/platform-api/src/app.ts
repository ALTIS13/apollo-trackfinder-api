import { randomUUID } from "node:crypto";

import cookieParser from "cookie-parser";
import express, { type RequestHandler } from "express";

import { platformDomainError } from "./domain/errors.js";
import type { EntitlementService } from "./domain/entitlements.js";
import type { InvitationService } from "./domain/invitations.js";
import type { OperatorSessionService } from "./domain/operator-sessions.js";
import type { RegistrationService } from "./domain/registration.js";
import { platformErrorHandler, validationError } from "./http/errors.js";
import type { RateLimiter } from "./http/rate-limit.js";
import { type PlatformLogger } from "./logger.js";
import {
  REGISTERED_PROTECTED_PLATFORM_ROUTES,
  registerOperatorRoutes,
} from "./routes/operator.js";
import { registerPublicRegistrationRoutes } from "./routes/public-registration.js";

export { REGISTERED_PROTECTED_PLATFORM_ROUTES } from "./routes/operator.js";

export interface PlatformApiDependencies {
  readonly registration: Pick<
    RegistrationService,
    | "getStatus"
    | "register"
    | "consumeVerificationToken"
    | "changeMode"
    | "activateAccount"
    | "suspendAccount"
  >;
  readonly invitations: Pick<InvitationService, "redeem" | "create" | "revoke">;
  readonly operatorSessions: Pick<
    OperatorSessionService,
    "bootstrap" | "login" | "authenticate" | "revoke"
  >;
  readonly entitlements: Pick<EntitlementService, "grant" | "revoke">;
  readonly readiness: () => Promise<boolean>;
  readonly rateLimiter: RateLimiter;
  readonly allowedOrigins: readonly string[];
  readonly trustProxyHops?: number;
  readonly developmentTokenEcho?: boolean;
  readonly bootstrapSecret?: string;
  readonly logger: PlatformLogger;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestIdMiddleware(): RequestHandler {
  return (request, response, next) => {
    const candidate = request.get("x-request-id");
    response.locals.requestId =
      candidate !== undefined && UUID_PATTERN.test(candidate)
        ? candidate
        : randomUUID();
    response.setHeader("X-Request-ID", response.locals.requestId);
    next();
  };
}

function jsonContentTypeMiddleware(): RequestHandler {
  return (request, _response, next) => {
    const requiresJson = ["POST", "PATCH", "PUT"].includes(request.method);
    const contentLength = Number(request.get("content-length") ?? "0");
    const hasBody =
      request.get("transfer-encoding") !== undefined ||
      (Number.isFinite(contentLength) && contentLength > 0);
    if (!requiresJson && !hasBody) return next();
    const contentType = request.get("content-type");
    if (
      contentType === undefined ||
      contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    ) {
      return next(validationError());
    }
    return next();
  };
}

function corsMiddleware(allowedOrigins: readonly string[]): RequestHandler {
  return (request, response, next) => {
    const origin = request.get("origin");
    if (origin !== undefined && allowedOrigins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Vary", "Origin");
      if (request.method === "OPTIONS") {
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, X-CSRF-Token, X-Request-ID",
        );
        response.setHeader(
          "Access-Control-Allow-Methods",
          "DELETE, GET, PATCH, POST, PUT",
        );
        response.status(204).end();
        return;
      }
    }
    next();
  };
}

export function createPlatformApp(dependencies: PlatformApiDependencies) {
  const app = express();
  const trustProxyHops = dependencies.trustProxyHops ?? 0;
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error("trustProxyHops must be a non-negative integer");
  }
  app.set("trust proxy", trustProxyHops);
  app.locals.logger = dependencies.logger;
  app.disable("x-powered-by");
  app.use(requestIdMiddleware());
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.path.startsWith("/v1/")) {
      response.setHeader("Cache-Control", "no-store");
    }
    next();
  });
  app.use(corsMiddleware(dependencies.allowedOrigins));
  app.use(jsonContentTypeMiddleware());
  app.use(
    express.json({ limit: "64kb", strict: true, type: "application/json" }),
  );
  app.use(cookieParser());
  app.use((request, response, next) => {
    response.on("finish", () => {
      dependencies.logger.info(
        {
          requestId: String(response.locals.requestId),
          method: request.method,
          path: request.path,
          status: response.statusCode,
        },
        "request completed",
      );
    });
    next();
  });

  app.get("/healthz", (_request, response) => response.json({ ok: true }));
  app.get("/readyz", async (_request, response, next) => {
    try {
      if (!(await dependencies.readiness())) {
        throw platformDomainError("policy_unavailable");
      }
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  registerPublicRegistrationRoutes(app, {
    registration: dependencies.registration,
    invitations: dependencies.invitations,
    rateLimiter: dependencies.rateLimiter,
    developmentTokenEcho: dependencies.developmentTokenEcho === true,
  });
  registerOperatorRoutes(app, dependencies);
  app.use(platformErrorHandler);
  return app;
}
