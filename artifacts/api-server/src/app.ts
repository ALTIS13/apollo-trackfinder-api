import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Logger } from "pino";
import pinoHttp from "pino-http";

import { adminRequestTelemetry } from "./lib/admin-telemetry.js";
import { logger } from "./lib/logger.js";
import { createApiRouter, type ApiRouterOptions } from "./routes/index.js";
import { moduleHeartbeatRouter } from "./routes/module-heartbeats.js";

const PRODUCTION_ORIGINS = [
  "https://web.apollot.ru",
  "https://tf.apollot.ru",
  "https://api.apollot.ru",
  "https://apollot.ru",
];
const API_BODY_LIMIT_BYTES = 100 * 1024;

interface SanitizedApiError {
  readonly status: 400 | 413 | 500;
  readonly body:
    | { readonly error: "invalid_request" }
    | { readonly error: "request_too_large" }
    | { readonly error: "internal_error" };
  readonly errorType:
    | "MalformedRequestBody"
    | "RequestBodyTooLarge"
    | "UnhandledApiError";
}

function dataProperty(
  value: object,
  key: PropertyKey,
  includeImmediatePrototype = false,
): unknown {
  const ownDescriptor = Object.getOwnPropertyDescriptor(value, key);
  if (ownDescriptor !== undefined) {
    return "value" in ownDescriptor ? ownDescriptor.value : undefined;
  }
  if (!includeImmediatePrototype) return undefined;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null) return undefined;
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(prototype, key);
  return prototypeDescriptor !== undefined && "value" in prototypeDescriptor
    ? prototypeDescriptor.value
    : undefined;
}

function hasExactParserStatus(error: object, status: 400 | 413): boolean {
  return (
    dataProperty(error, "status", true) === status &&
    dataProperty(error, "statusCode", true) === status &&
    dataProperty(error, "expose", true) === true
  );
}

function safeBodySize(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function isMalformedJsonError(error: object): boolean {
  if (
    !(error instanceof SyntaxError) ||
    dataProperty(error, "type") !== "entity.parse.failed" ||
    !hasExactParserStatus(error, 400)
  ) {
    return false;
  }
  const body = dataProperty(error, "body");
  if (
    typeof body !== "string" ||
    body.length === 0 ||
    body.length > API_BODY_LIMIT_BYTES
  ) {
    return false;
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  return bodyBytes > 0 && bodyBytes <= API_BODY_LIMIT_BYTES;
}

function isOversizedBodyError(error: object): boolean {
  if (
    !(error instanceof Error) ||
    dataProperty(error, "name") !== "PayloadTooLargeError" ||
    dataProperty(error, "type") !== "entity.too.large" ||
    !hasExactParserStatus(error, 413)
  ) {
    return false;
  }
  const limit = safeBodySize(dataProperty(error, "limit"));
  if (limit !== API_BODY_LIMIT_BYTES) return false;

  const length = safeBodySize(dataProperty(error, "length"));
  const expected = safeBodySize(dataProperty(error, "expected"));
  const received = safeBodySize(dataProperty(error, "received"));
  return (
    (length !== null &&
      expected !== null &&
      length === expected &&
      length > limit) ||
    (received !== null && received > limit)
  );
}

function classifyApiError(error: unknown): SanitizedApiError {
  try {
    if (typeof error === "object" && error !== null) {
      if (isMalformedJsonError(error)) {
        return {
          status: 400,
          body: { error: "invalid_request" },
          errorType: "MalformedRequestBody",
        };
      }
      if (isOversizedBodyError(error)) {
        return {
          status: 413,
          body: { error: "request_too_large" },
          errorType: "RequestBodyTooLarge",
        };
      }
    }
  } catch {
    // Treat hostile error objects as untrusted server errors.
  }
  return {
    status: 500,
    body: { error: "internal_error" },
    errorType: "UnhandledApiError",
  };
}

function isExactLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export interface ApiAppOptions extends ApiRouterOptions {
  readonly requestLogger?: Logger;
}

export function sanitizedApiErrorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const sanitized = classifyApiError(error);
  const logContext = {
    errorType: sanitized.errorType,
    method: request.method,
    path: request.path,
  };
  if (sanitized.status < 500) {
    request.log.warn(logContext, "API request rejected");
  } else {
    request.log.error(logContext, "API request failed");
  }
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.status(sanitized.status).json(sanitized.body);
}

export function createApiApp(options: ApiAppOptions = {}): Express {
  const app: Express = express();
  const requestLogger = options.requestLogger ?? logger;
  const allowedOrigins = new Set(PRODUCTION_ORIGINS);
  if (options.auth !== undefined) {
    allowedOrigins.add(options.auth.webOrigin);
  }

  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      logger: requestLogger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );

  app.use((request, response, next) => {
    response.once("finish", () => {
      adminRequestTelemetry.record({
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
      });
    });
    next();
  });

  app.use("/api", moduleHeartbeatRouter);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        if (isExactLoopbackOrigin(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
    }),
  );

  app.use(express.json({ limit: API_BODY_LIMIT_BYTES }));
  app.use(express.urlencoded({ extended: true, limit: API_BODY_LIMIT_BYTES }));
  app.use(cookieParser());

  app.use("/api", createApiRouter(options));
  app.use("/api", sanitizedApiErrorHandler);
  return app;
}
