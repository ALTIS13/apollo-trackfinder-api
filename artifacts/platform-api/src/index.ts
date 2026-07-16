import { createServer } from "node:http";

import Redis from "ioredis";

import {
  PLATFORM_MIGRATION_MANIFEST,
  createPlatformPool,
} from "@workspace/platform-db";

import { createPlatformApp } from "./app.js";
import { EntitlementService } from "./domain/entitlements.js";
import { InvitationService } from "./domain/invitations.js";
import { OperatorSessionService } from "./domain/operator-sessions.js";
import { PostgresPlatformRepository } from "./domain/postgres-repository.js";
import { RegistrationService } from "./domain/registration.js";
import { createPlatformLogger } from "./logger.js";
import { RedisRateLimitStore, SharedRateLimiter } from "./http/rate-limit.js";
import { createMigrationReadinessProbe } from "./readiness.js";
import { parsePlatformRuntimeConfig } from "./runtime-config.js";
import {
  RedisConnectionReadiness,
  combineRuntimeReadiness,
} from "./runtime-readiness.js";

async function start(): Promise<void> {
  const config = parsePlatformRuntimeConfig(process.env);
  const logger = createPlatformLogger();
  const pool = createPlatformPool(config.databaseUrl);
  const redis = new Redis(config.redisUrl, {
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  const repository = new PostgresPlatformRepository();
  const clock = () => new Date();
  const redisReadiness = new RedisConnectionReadiness(redis, logger);
  redisReadiness.start();
  const readiness = combineRuntimeReadiness(
    redisReadiness,
    createMigrationReadinessProbe(pool, PLATFORM_MIGRATION_MANIFEST),
  );
  const app = createPlatformApp({
    registration: new RegistrationService(pool, repository, clock),
    invitations: new InvitationService(pool, repository, clock),
    operatorSessions: new OperatorSessionService(
      pool,
      repository,
      config.operatorBootstrapToken,
      clock,
    ),
    entitlements: new EntitlementService(pool, repository, clock),
    readiness,
    rateLimiter: new SharedRateLimiter(new RedisRateLimitStore(redis), {
      limit: 10,
      windowMs: 60_000,
    }),
    allowedOrigins: config.allowedOrigins,
    developmentTokenEcho:
      config.nodeEnv !== "production" && config.developmentTokenEcho,
    logger,
    trustProxyHops: config.trustProxyHops,
  });
  const server = createServer(app);
  const port = config.port;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      redisReadiness.stop();
      void pool.end().finally(() => process.exit(0));
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(port, () => logger.info({ port }, "listening"));
}

void start().catch((error: unknown) => {
  process.stderr.write("Platform API startup failed\n");
  process.exitCode = 1;
  if (error instanceof Error) process.stderr.write(`${error.message}\n`);
});
