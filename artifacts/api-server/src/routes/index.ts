import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import tracksRouter from "./tracks.js";
import spotifyRouter from "./spotify.js";
import yandexRouter from "./yandex.js";
import { adminRouter } from "./admin.js";
import { createAuthRouter, type AuthRouteDependencies } from "./auth.js";

export interface ApiRouterOptions {
  readonly auth?: AuthRouteDependencies;
}

export function createApiRouter(options: ApiRouterOptions = {}): IRouter {
  const router: IRouter = Router();
  if (options.auth !== undefined) {
    router.use("/auth", createAuthRouter(options.auth));
  }
  router.use(healthRouter);
  router.use(tracksRouter);
  router.use(spotifyRouter);
  router.use(yandexRouter);
  router.use(adminRouter);
  return router;
}

export default createApiRouter();
