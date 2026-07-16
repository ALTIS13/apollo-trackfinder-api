import { createServer } from "node:http";

import { createPlatformPool } from "@workspace/platform-db";

import { createPlatformApp } from "./app.js";
import { EntitlementService } from "./domain/entitlements.js";
import { InvitationService } from "./domain/invitations.js";
import { OperatorSessionService } from "./domain/operator-sessions.js";
import { PostgresPlatformRepository } from "./domain/postgres-repository.js";
import { RegistrationService } from "./domain/registration.js";
import { createPlatformLogger } from "./logger.js";

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
  const repository = new PostgresPlatformRepository();
  const clock = () => new Date();
  const readiness = async (): Promise<boolean> => {
    try {
      const result = await pool.query<{
        readonly migrations: string | null;
        readonly settings: string | null;
      }>(
        "select to_regclass('apollo_platform.schema_migrations')::text as migrations, to_regclass('apollo_platform.registration_settings')::text as settings",
      );
      const row = result.rows[0];
      return row?.migrations !== null && row?.settings !== null;
    } catch {
      return false;
    }
  };
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
    allowedOrigins: configuredOrigins(
      requiredEnvironment("APOLLO_ALLOWED_ORIGINS"),
    ),
    developmentTokenEcho: nodeEnv !== "production" && echoRequested,
    logger,
  });
  const server = createServer(app);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(configuredPort(), () =>
    logger.info({ port: configuredPort() }, "listening"),
  );
}

void start().catch((error: unknown) => {
  process.stderr.write("Platform API startup failed\n");
  process.exitCode = 1;
  if (error instanceof Error) process.stderr.write(`${error.message}\n`);
});
