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
import {
  RedisConnectionReadiness,
  combineRuntimeReadiness,
} from "./runtime-readiness.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function configuredOrigins(value: string): readonly string[] {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0)
    throw new Error("APOLLO_ALLOWED_ORIGINS must not be empty");
  for (const origin of origins) {
    if (new URL(origin).origin !== origin) {
      throw new Error("APOLLO_ALLOWED_ORIGINS entries must be exact origins");
    }
  }
  return Object.freeze([...new Set(origins)]);
}

function configuredPort(): number {
  const value = process.env.PORT ?? "3000";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port");
  }
  return port;
}

function configuredTrustProxyHops(): number {
  const value = process.env.APOLLO_TRUST_PROXY_HOPS ?? "0";
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 2) {
    throw new Error("APOLLO_TRUST_PROXY_HOPS must be an integer from 0 to 2");
  }
  return hops;
}

async function start(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const echoRequested = process.env.APOLLO_DEVELOPMENT_TOKEN_ECHO === "true";
  if (nodeEnv === "production" && echoRequested) {
    throw new Error(
      "APOLLO_DEVELOPMENT_TOKEN_ECHO is prohibited in production",
    );
  }

  const logger = createPlatformLogger();
  const pool = createPlatformPool(requiredEnvironment("DATABASE_URL"));
  const redis = new Redis(requiredEnvironment("APOLLO_REDIS_URL"), {
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
      requiredEnvironment("APOLLO_OPERATOR_BOOTSTRAP_TOKEN"),
      clock,
    ),
    entitlements: new EntitlementService(pool, repository, clock),
    readiness,
    rateLimiter: new SharedRateLimiter(new RedisRateLimitStore(redis), {
      limit: 10,
      windowMs: 60_000,
    }),
    allowedOrigins: configuredOrigins(
      requiredEnvironment("APOLLO_ALLOWED_ORIGINS"),
    ),
    developmentTokenEcho: nodeEnv !== "production" && echoRequested,
    logger,
    trustProxyHops: configuredTrustProxyHops(),
  });
  const server = createServer(app);
  const port = configuredPort();
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
