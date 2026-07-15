import express, {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  moduleHeartbeatService,
  type ModuleHeartbeatService,
} from "../lib/module-heartbeat.js";

export interface CreateModuleHeartbeatRouterOptions {
  service?: Pick<ModuleHeartbeatService, "ingest">;
}

const HEARTBEAT_PATH = "/internal/modules/:moduleId/heartbeat";

function setHeartbeatResponseHeaders(res: Response): void {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

function isJsonContentType(req: Request): boolean {
  return req.is("application/json") !== false;
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
  const router = Router();
  const service = options.service ?? moduleHeartbeatService;

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
    express.raw({ type: () => true, limit: "8kb" }),
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
            res.status(202).json({ receivedAt: result.receivedAt });
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
    res.status(405).json({ error: "method_not_allowed" });
  });

  router.use(
    (error: unknown, req: Request, res: Response, _next: NextFunction) => {
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
