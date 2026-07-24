import Redis from "ioredis";

import { createApiApp } from "./app.js";
import {
  initBackgroundQueues,
  shutdownBackgroundQueues,
} from "./lib/background-queue.js";
import { logger } from "./lib/logger.js";
import { runMigrations } from "./lib/migrate.js";
import {
  PlatformAuthClient,
  parseTfAuthRuntimeConfig,
} from "./lib/platform-auth-client.js";
import { getRedis } from "./lib/redis.js";
import {
  TfSessionStore,
  createStrictRedisClient,
} from "./lib/tf-session-store.js";
import { attachWebSocketServer } from "./ws.js";

async function start(): Promise<void> {
  const authConfig = await parseTfAuthRuntimeConfig(process.env);
  const rawPort = process.env["PORT"];
  if (rawPort === undefined) {
    throw new Error("invalid runtime configuration");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid runtime configuration");
  }

  const authRedis = new Redis(authConfig.authRedisUrl, {
    connectTimeout: 3_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  authRedis.on("error", () => {
    logger.error(
      { component: "tf-auth-store" },
      "TF authentication storage unavailable",
    );
  });

  try {
    await authRedis.connect();
    await authRedis.ping();
    const platform = new PlatformAuthClient({
      issuer: authConfig.issuer,
      clientId: authConfig.clientId,
      redirectUri: authConfig.callbackUrl,
      clientSecret: authConfig.clientSecret,
    });
    const sessionStore = new TfSessionStore(createStrictRedisClient(authRedis));
    const app = createApiApp({
      auth: {
        platform,
        sessionStore,
        webOrigin: authConfig.webOrigin,
        secureCookies: true,
      },
    });

    getRedis();
    await runMigrations();
    const server = app.listen(port, () => {
      logger.info({ port }, "Server listening");
    });
    attachWebSocketServer(server);
    await initBackgroundQueues();

    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close(() => {
        void shutdownBackgroundQueues()
          .then(() => authRedis.quit())
          .catch(() => {
            authRedis.disconnect(false);
          })
          .finally(() => process.exit(0));
      });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error) {
    authRedis.disconnect(false);
    throw error;
  }
}

void start().catch(() => {
  process.stderr.write("TF API startup failed\n");
  process.exitCode = 1;
});
