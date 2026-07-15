import express, {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  isCanonicalModuleHeartbeatPath,
  moduleHeartbeatService,
  type ModuleHeartbeatService,
} from "../lib/module-heartbeat.js";

export interface CreateModuleHeartbeatRouterOptions {
  service?: Pick<ModuleHeartbeatService, "ingest">;
}

const HEARTBEAT_PATH = "/internal/modules/:moduleId/heartbeat";
const HEARTBEAT_PATH_CANDIDATE =
  /^\/api\/internal\/modules\/([^/]*)\/heartbeat\/?$/i;

function setHeartbeatResponseHeaders(res: Response): void {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

function isJsonContentType(req: Request): boolean {
  return req.is("application/json") !== false;
}

function getRequestPath(req: Request): string {
  const queryIndex = req.originalUrl.indexOf("?");
  return queryIndex === -1
    ? req.originalUrl
    : req.originalUrl.slice(0, queryIndex);
}

function hasMalformedModuleId(path: string): boolean {
  const match = HEARTBEAT_PATH_CANDIDATE.exec(path);
  if (match === null) return false;

  try {
    decodeURIComponent(match[1] ?? "");
    return false;
  } catch {
    return true;
  }
}

function rejectNonIdentityEncoding(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const contentEncoding = req.get("Content-Encoding");
  if (contentEncoding === undefined) {
    next();
    return;
  }

  const encodings = contentEncoding.split(",").map((value) => value.trim());
  if (
    encodings.length === 0 ||
    encodings.some((encoding) => encoding.toLowerCase() !== "identity")
  ) {
    res.status(400).json({ error: "invalid_heartbeat" });
    return;
  }

  delete req.headers["content-encoding"];
  next();
}

function isRequestBodyTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  );
}

function getParserErrorType(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "type" in error &&
    typeof error.type === "string"
    ? error.type
    : "unknown";
}

export function createModuleHeartbeatRouter(
  options: CreateModuleHeartbeatRouterOptions = {},
): IRouter {
  const router = Router({ caseSensitive: true, strict: true });
  const service = options.service ?? moduleHeartbeatService;

  router.use((req: Request, res: Response, next: NextFunction) => {
    const path = getRequestPath(req);
    if (!HEARTBEAT_PATH_CANDIDATE.test(path)) {
      next();
      return;
    }

    setHeartbeatResponseHeaders(res);
    if (isCanonicalModuleHeartbeatPath(path)) {
      next();
      return;
    }

    const malformedModuleId = hasMalformedModuleId(path);
    res.status(malformedModuleId ? 400 : 404).json({
      error: malformedModuleId ? "invalid_heartbeat" : "not_found",
    });
  });

  const applyHeartbeatResponseHeaders = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    setHeartbeatResponseHeaders(res);
    next();
  };

  router.post(
    HEARTBEAT_PATH,
    applyHeartbeatResponseHeaders,
    rejectNonIdentityEncoding,
    express.raw({ type: () => true, limit: 8 * 1024, inflate: false }),
    (req, res) => {
      try {
        if (!isJsonContentType(req)) {
          res.status(400).json({ error: "invalid_heartbeat" });
          return;
        }

        const moduleId = req.params.moduleId;
        const result = service.ingest({
          moduleId: typeof moduleId === "string" ? moduleId : "",
          timestamp: req.get("X-Apollo-Heartbeat-Timestamp"),
          nonce: req.get("X-Apollo-Heartbeat-Nonce"),
          signature: req.get("X-Apollo-Heartbeat-Signature"),
          rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        });

        switch (result.kind) {
          case "accepted":
            res
              .status(202)
              .json({ accepted: true, receivedAt: result.receivedAt });
            return;
          case "disabled":
            res.status(503).json({ error: "heartbeat_disabled" });
            return;
          case "unauthorized":
            res.status(401).json({ error: "unauthorized" });
            return;
          case "invalid":
            res.status(400).json({ error: "invalid_heartbeat" });
            return;
          case "stale":
            res.status(409).json({ error: "stale_heartbeat" });
            return;
        }
      } catch (error) {
        req.log?.warn(
          { errorType: error instanceof Error ? error.name : "UnknownError" },
          "Module heartbeat unavailable",
        );
        res.status(503).json({ error: "heartbeat_unavailable" });
      }
    },
  );

  router.all(HEARTBEAT_PATH, applyHeartbeatResponseHeaders, (_req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
  });

  router.use(
    (error: unknown, req: Request, res: Response, _next: NextFunction) => {
      setHeartbeatResponseHeaders(res);
      req.log?.warn(
        { errorType: getParserErrorType(error) },
        "Module heartbeat parser failure",
      );
      res.status(isRequestBodyTooLarge(error) ? 413 : 400).json({
        error: isRequestBodyTooLarge(error)
          ? "heartbeat_too_large"
          : "invalid_heartbeat",
      });
    },
  );

  return router;
}

export const moduleHeartbeatRouter = createModuleHeartbeatRouter();
