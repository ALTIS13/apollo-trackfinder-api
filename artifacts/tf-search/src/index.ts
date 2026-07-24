import { createTfSearchApp } from "./app.js";
import { parseTfSearchRuntimeConfig } from "./config.js";
import { startSearchHeartbeat } from "./heartbeat.js";
import { HmacInternalRequestAuthenticator } from "./internal-auth.js";
import { logger } from "./logger.js";
import { createRuntimeProviders } from "./runtime-providers.js";
import { createSearchService } from "./search-service.js";

async function start(): Promise<void> {
  const config = await parseTfSearchRuntimeConfig(process.env);
  const service = createSearchService({
    providers: createRuntimeProviders(config.fixtureAdapters),
    logger: {
      warn({ source, errorClass }) {
        logger.warn({ source, errorClass }, "Search provider unavailable");
      },
    },
  });
  let initialized = false;
  const app = createTfSearchApp({
    service,
    auth: new HmacInternalRequestAuthenticator({ secret: config.internalAuthSecret }),
    ready: () => initialized,
  });
  const server = app.listen(config.port);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  initialized = true;
  const heartbeat = startSearchHeartbeat({
    apiOrigin: config.heartbeatApiOrigin,
    secret: config.heartbeatSecret,
    version: config.version,
    ...(config.deployedAt === undefined ? {} : { deployedAt: config.deployedAt }),
    ready: () => initialized,
    telemetry: () => service.telemetry(),
  });
  logger.info({ port: config.port }, "TF search listening");

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    initialized = false;
    void (async () => {
      await heartbeat.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.exit(0);
    })();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void start().catch(() => {
  process.stderr.write("TF search startup failed\n");
  process.exitCode = 1;
});
