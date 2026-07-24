import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

export function createHealthRouter(
  readiness: () => Promise<boolean> = async () => true,
): IRouter {
  const router: IRouter = Router();
  let readinessInFlight: Promise<boolean> | undefined;
  const sharedReadiness = (): Promise<boolean> => {
    if (readinessInFlight !== undefined) return readinessInFlight;
    const current = Promise.resolve()
      .then(readiness)
      .finally(() => {
        if (readinessInFlight === current) readinessInFlight = undefined;
      });
    readinessInFlight = current;
    return current;
  };

  router.get("/healthz", (_req, res) => {
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  });

  router.get("/readyz", async (_req, res) => {
    try {
      if (!(await sharedReadiness())) {
        res.status(503).json({ status: "unavailable" });
        return;
      }
      res.json(HealthCheckResponse.parse({ status: "ok" }));
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  return router;
}

export default createHealthRouter();
