import { TextDecoder } from "node:util";

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  TF_INTEGRATIONS_COMMAND_PATH,
  tfIntegrationsCommandSchema,
  tfIntegrationsErrorResponseSchema,
  tfIntegrationsSuccessResponseSchema,
  type TfIntegrationsCommand,
  type TfIntegrationsErrorResponse,
  type TfIntegrationsSuccessResponse,
} from "@workspace/tf-integrations-contract";

import type { InternalRequestAuthenticator } from "./internal-auth.js";

const BODY_LIMIT = 64 * 1024;
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export interface TfIntegrationsCommandService {
  execute(
    command: TfIntegrationsCommand,
  ): Promise<TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse>;
}

export interface TfIntegrationsReadiness {
  check(): Promise<boolean>;
}

export interface CreateTfIntegrationsReadinessOptions {
  readonly isMigrationCurrent: () => Promise<boolean>;
  readonly probeDatabase: () => Promise<boolean>;
  readonly timeoutMs?: number;
}

export interface CreateTfIntegrationsAppOptions {
  readonly service: TfIntegrationsCommandService;
  readonly auth: InternalRequestAuthenticator;
  readonly readiness: TfIntegrationsReadiness;
}

export function createTfIntegrationsReadiness(
  options: CreateTfIntegrationsReadinessOptions,
): TfIntegrationsReadiness {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("invalid readiness timeout");
  }

  return {
    async check(): Promise<boolean> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const readiness = Promise.all([
        options.isMigrationCurrent(),
        options.probeDatabase(),
      ]).then(
        ([migrationCurrent, databaseAvailable]) =>
          migrationCurrent === true && databaseAvailable === true,
        () => false,
      );
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        return await Promise.race([readiness, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

function setResponseHeaders(res: Response): void {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

function requestPath(req: Request): string {
  const queryIndex = req.originalUrl.indexOf("?");
  return queryIndex === -1
    ? req.originalUrl
    : req.originalUrl.slice(0, queryIndex);
}

function isIdentityEncoding(req: Request): boolean {
  const value = req.get("Content-Encoding");
  if (value === undefined) return true;
  const encodings = value.split(",").map((entry) => entry.trim().toLowerCase());
  return (
    encodings.length > 0 && encodings.every((entry) => entry === "identity")
  );
}

function isJsonContentType(req: Request): boolean {
  const value = req.get("Content-Type");
  return (
    value !== undefined &&
    value.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

function rejectUnsupportedTransport(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isIdentityEncoding(req) || !isJsonContentType(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  delete req.headers["content-encoding"];
  next();
}

function rawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function parseJsonBody(value: Buffer): unknown | undefined {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
    ) as unknown;
  } catch {
    return undefined;
  }
}

function authenticate(
  req: Request,
  auth: InternalRequestAuthenticator,
): boolean {
  try {
    return auth.authenticate({
      method: req.method,
      path: requestPath(req),
      timestamp: req.get("X-Apollo-Internal-Timestamp"),
      nonce: req.get("X-Apollo-Internal-Nonce"),
      signature: req.get("X-Apollo-Internal-Signature"),
      rawBody: rawBody(req),
    });
  } catch {
    return false;
  }
}

function isCorrelatedResponse(
  command: TfIntegrationsCommand,
  response: TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse,
): boolean {
  return (
    response.requestId === command.requestId &&
    response.accountId === command.accountId &&
    response.operation === command.operation
  );
}

async function isReady(readiness: TfIntegrationsReadiness): Promise<boolean> {
  try {
    return await readiness.check();
  } catch {
    return false;
  }
}

export function createTfIntegrationsApp(
  options: CreateTfIntegrationsAppOptions,
): Express {
  const app = express();
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  app.use((_req, res, next) => {
    setResponseHeaders(res);
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    const ready = await isReady(options.readiness);
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "unavailable",
    });
  });

  app.post(
    TF_INTEGRATIONS_COMMAND_PATH,
    rejectUnsupportedTransport,
    express.raw({ type: () => true, limit: BODY_LIMIT, inflate: false }),
    async (req, res) => {
      if (!authenticate(req, options.auth)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      if (!(await isReady(options.readiness))) {
        res.status(503).json({ error: "integrations_unavailable" });
        return;
      }

      const command = tfIntegrationsCommandSchema.safeParse(
        parseJsonBody(rawBody(req)),
      );
      if (!command.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }

      try {
        const rawResponse = await options.service.execute(command.data);
        const success =
          tfIntegrationsSuccessResponseSchema.safeParse(rawResponse);
        const failure =
          tfIntegrationsErrorResponseSchema.safeParse(rawResponse);
        const parsed = success.success
          ? success.data
          : failure.success
            ? failure.data
            : undefined;
        if (
          parsed === undefined ||
          !isCorrelatedResponse(command.data, parsed)
        ) {
          res.status(500).json({ error: "internal_error" });
          return;
        }
        res.status(200).json(parsed);
      } catch {
        res.status(500).json({ error: "internal_error" });
      }
    },
  );

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) return;
      const status =
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "entity.too.large"
          ? 413
          : 400;
      res.status(status).json({ error: "invalid_request" });
    },
  );

  return app;
}
