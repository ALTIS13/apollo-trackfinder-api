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
import type { TfIntegrationsCommandContext } from "@workspace/tf-integrations-db";

import type {
  InternalRequestAuthenticator,
  VerifiedInternalRequest,
} from "./internal-auth.js";

const BODY_LIMIT = 64 * 1024;
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 8_000;
const MAX_COMMAND_TIMEOUT_MS = 9_000;
const MAX_CONCURRENT_COMMANDS = 32;

export interface TfIntegrationsCommandService {
  execute(
    command: TfIntegrationsCommand,
    context: TfIntegrationsCommandContext,
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
  readonly commandTimeoutMs?: number;
  readonly maxConcurrentCommands?: number;
  readonly shutdownSignal?: AbortSignal;
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

function requestTarget(req: Request): string {
  return req.originalUrl;
}

function requirePermittedRoute(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const path = requestTarget(req);
  if (
    (req.method === "GET" && (path === "/healthz" || path === "/readyz")) ||
    (req.method === "POST" && path === TF_INTEGRATIONS_COMMAND_PATH)
  ) {
    next();
    return;
  }
  res.status(404).end();
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
): VerifiedInternalRequest | undefined {
  try {
    return auth.verify({
      method: req.method,
      path: requestTarget(req),
      timestamp: req.get("X-Apollo-Internal-Timestamp"),
      nonce: req.get("X-Apollo-Internal-Nonce"),
      signature: req.get("X-Apollo-Internal-Signature"),
      rawBody: rawBody(req),
    });
  } catch {
    return undefined;
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

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

interface CommandAbortScope extends TfIntegrationsCommandContext {
  dispose(): void;
}

function commandContextExpired(context: TfIntegrationsCommandContext): boolean {
  return (
    context.signal.aborted ||
    !Number.isSafeInteger(context.deadlineAt) ||
    Date.now() >= context.deadlineAt
  );
}

function respondIntegrationsUnavailable(res: Response): void {
  if (!res.headersSent && !res.destroyed) {
    res.status(503).json({ error: "integrations_unavailable" });
  }
}

function createCommandAbortScope(
  req: Request,
  res: Response,
  timeoutMs: number,
  shutdownSignal?: AbortSignal,
): CommandAbortScope {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const abort = (): void => controller.abort();
  const abortOnClose = (): void => {
    if (!res.writableEnded) abort();
  };
  const timeout = setTimeout(abort, Math.max(0, deadlineAt - Date.now()));

  req.once("aborted", abort);
  res.once("close", abortOnClose);
  shutdownSignal?.addEventListener("abort", abort, { once: true });
  if (req.aborted || shutdownSignal?.aborted) abort();

  return {
    signal: controller.signal,
    deadlineAt,
    dispose(): void {
      clearTimeout(timeout);
      req.off("aborted", abort);
      res.off("close", abortOnClose);
      shutdownSignal?.removeEventListener("abort", abort);
    },
  };
}

export function createTfIntegrationsApp(
  options: CreateTfIntegrationsAppOptions,
): Express {
  const commandTimeoutMs = boundedInteger(
    options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
    1,
    MAX_COMMAND_TIMEOUT_MS,
    "command timeout",
  );
  const maxConcurrentCommands = boundedInteger(
    options.maxConcurrentCommands ?? MAX_CONCURRENT_COMMANDS,
    1,
    MAX_CONCURRENT_COMMANDS,
    "command concurrency",
  );
  let activeCommands = 0;
  const app = express();
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  app.use((_req, res, next) => {
    setResponseHeaders(res);
    next();
  });
  app.use(requirePermittedRoute);

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
      const proof = authenticate(req, options.auth);
      if (proof === undefined) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const command = tfIntegrationsCommandSchema.safeParse(
        parseJsonBody(rawBody(req)),
      );
      if (!command.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      if (activeCommands >= maxConcurrentCommands) {
        res.status(503).json({ error: "integrations_unavailable" });
        return;
      }

      activeCommands += 1;
      const scope = createCommandAbortScope(
        req,
        res,
        commandTimeoutMs,
        options.shutdownSignal,
      );
      try {
        if (
          !(await isReady(options.readiness)) ||
          commandContextExpired(scope)
        ) {
          respondIntegrationsUnavailable(res);
          return;
        }
        const claim = options.auth.claim(command.data.accountId, proof);
        if (claim !== "accepted") {
          if (claim === "capacity_exhausted") {
            res.status(503).json({ error: "integrations_unavailable" });
          } else {
            res.status(401).json({ error: "unauthorized" });
          }
          return;
        }
        const rawResponse = await options.service.execute(command.data, scope);
        if (commandContextExpired(scope)) {
          respondIntegrationsUnavailable(res);
          return;
        }
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
        if (commandContextExpired(scope)) {
          respondIntegrationsUnavailable(res);
          return;
        }
        if (!res.headersSent && !res.destroyed) {
          res.status(500).json({ error: "internal_error" });
        }
      } finally {
        scope.dispose();
        activeCommands -= 1;
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
