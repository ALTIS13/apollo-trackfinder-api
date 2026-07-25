import Redis from "ioredis";
import { probeDatabaseHealth } from "@workspace/db";

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
import { probeRedisHealth } from "./lib/redis-readiness.js";
import {
  TfSessionStore,
  createStrictRedisClient,
} from "./lib/tf-session-store.js";
import {
  HttpTfIntegrationsClient,
  parseTfIntegrationsClientConfig,
} from "./lib/tf-integrations-client.js";
import {
  HttpTfSearchClient,
  parseTfSearchClientConfig,
} from "./lib/tf-search-client.js";
import {
  initializeApiRuntime,
  startApiListener,
} from "./lib/server-startup.js";
import { attachWebSocketServer } from "./ws.js";
import type { WebSocketServerHandle } from "./ws.js";

async function start(): Promise<void> {
  const [authConfig, integrationsConfig, searchConfig] = await Promise.all([
    parseTfAuthRuntimeConfig(process.env),
    parseTfIntegrationsClientConfig(process.env),
    parseTfSearchClientConfig(process.env),
  ]);
  const rawPort = process.env["PORT"];
  if (rawPort === undefined) {
    throw new Error("invalid runtime configuration");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid runtime configuration");
  }

  const authRedis = new Redis(authConfig.authRedisUrl, {
    commandTimeout: 1_000,
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
  let cacheRedis: Redis | null = null;
  let webSocketHandle: WebSocketServerHandle | null = null;
  let redisClosed = false;
  const closeRedisResources = async (): Promise<void> => {
    if (redisClosed) return;
    redisClosed = true;
    cacheRedis?.disconnect(false);
    authRedis.disconnect(false);
  };

  try {
    await authRedis.connect();
    await authRedis.ping();
    const platform = new PlatformAuthClient({
      issuer: authConfig.issuer,
      apiOrigin: authConfig.apiOrigin,
      allowPrivateHttpTransport: authConfig.allowPrivateHttpTransport,
      clientId: authConfig.clientId,
      redirectUri: authConfig.callbackUrl,
      clientSecret: authConfig.clientSecret,
    });
    const sessionStore = new TfSessionStore(createStrictRedisClient(authRedis));
    const integrationsGateway = new HttpTfIntegrationsClient(
      integrationsConfig,
    );
    const searchGateway = new HttpTfSearchClient(searchConfig);
    const app = createApiApp({
      nodeEnv: authConfig.nodeEnv,
      readiness: async () => {
        try {
          const [redisReady, databaseReady] = await Promise.all([
            probeRedisHealth(authConfig.authRedisUrl, { timeoutMs: 1_200 }),
            probeDatabaseHealth({ timeoutMs: 1_200 }),
          ]);
          return redisReady && databaseReady;
        } catch {
          return false;
        }
      },
      auth: {
        platform,
        sessionStore,
        webOrigin: authConfig.webOrigin,
        secureCookies: true,
        ...(authConfig.bridgePkceVerifier === undefined
          ? {}
          : { pkceVerifier: () => authConfig.bridgePkceVerifier! }),
      },
      integrationsGateway,
      tracks: { searchGateway },
    });

    cacheRedis = getRedis();
    await runMigrations();
    const server = await startApiListener({
      listen: () => app.listen(port),
      initialize: async (listeningServer) => {
        webSocketHandle = await initializeApiRuntime(listeningServer, {
          attachWebSocket: (server) =>
            attachWebSocketServer(server, {
              platform,
              sessionStore,
            }),
          initializeAfterAttach: initBackgroundQueues,
        });
      },
      closeQueues: shutdownBackgroundQueues,
      closeRedis: closeRedisResources,
    });
    logger.info({ port }, "Server listening");

    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        await webSocketHandle?.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        await Promise.allSettled([
          shutdownBackgroundQueues(),
          closeRedisResources(),
        ]);
        process.exit(0);
      })();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch {
    await Promise.allSettled([
      shutdownBackgroundQueues(),
      closeRedisResources(),
    ]);
    throw new Error("TF API startup failed");
  }
}

void start().catch(() => {
  process.stderr.write("TF API startup failed\n");
  process.exitCode = 1;
});
