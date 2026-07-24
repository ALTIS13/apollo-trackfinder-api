import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import tracksRouter from "./tracks.js";
import {
  createSpotifyRouter,
  type SpotifyRouteDependencies,
} from "./spotify.js";
import { createYandexRouter, type YandexRouteDependencies } from "./yandex.js";
import { adminRouter } from "./admin.js";
import { createAuthRouter, type AuthRouteDependencies } from "./auth.js";
import { requireTfCapability } from "../lib/tf-policy.js";

export interface ApiRouterOptions {
  readonly auth?: AuthRouteDependencies;
  readonly spotify?: Omit<
    Partial<SpotifyRouteDependencies>,
    "providerOAuthStateStore"
  >;
  readonly yandex?: Partial<YandexRouteDependencies>;
}

export function createApiRouter(options: ApiRouterOptions = {}): IRouter {
  const router: IRouter = Router();
  if (options.auth !== undefined) {
    router.use("/auth", createAuthRouter(options.auth));
  }
  router.use(healthRouter);
  if (options.auth === undefined) {
    router.use(["/tracks", "/spotify", "/yandex"], (_request, response) => {
      response.status(503).json({ error: "policy_unavailable" });
    });
  } else {
    router.use(
      ["/tracks", "/spotify", "/yandex"],
      requireTfCapability({
        platform: options.auth.platform,
        sessionStore: options.auth.sessionStore,
      }),
    );
  }
  router.use(tracksRouter);
  router.use(
    createSpotifyRouter({
      ...options.spotify,
      ...(options.auth === undefined
        ? {}
        : { providerOAuthStateStore: options.auth.sessionStore }),
    }),
  );
  router.use(createYandexRouter(options.yandex));
  router.use(adminRouter);
  return router;
}

export default createApiRouter();
