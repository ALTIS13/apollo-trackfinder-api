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

function setHeartbeatResponseHeaders(res: Response): void {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

function isRequestBodyTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  );
}

export function createModuleHeartbeatRouter(
  options: CreateModuleHeartbeatRouterOptions = {},
): IRouter {
  const router = Router();
  const service = options.service ?? moduleHeartbeatService;

  router.use((_req, res, next) => {
    setHeartbeatResponseHeaders(res);
    next();
  });

  router.get("/internal/modules/:moduleId/heartbeat", (_req, res) => {
    res.status(405).json({ error: "method_not_allowed" });
  });

  router.post(
    "/internal/modules/:moduleId/heartbeat",
    express.raw({ type: "application/json", limit: "8kb" }),
    (req, res) => {
      try {
        const result = service.ingest({
          moduleId: req.params.moduleId ?? "",
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

  router.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (!isRequestBodyTooLarge(error)) {
        next(error);
        return;
      }
      res.status(413).json({ error: "heartbeat_too_large" });
    },
  );

  return router;
}

export const moduleHeartbeatRouter = createModuleHeartbeatRouter();
