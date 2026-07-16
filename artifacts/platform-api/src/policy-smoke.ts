import { readFile } from "node:fs/promises";

import {
  createPlatformPool,
  setAccountContext,
  withPlatformTransaction,
} from "@workspace/platform-db";

import { PolicyService } from "./domain/policy.js";
import { PostgresPlatformRepository } from "./domain/postgres-repository.js";
import { digestOpaqueToken } from "./domain/security.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

async function sessionToken(): Promise<string> {
  const path = requiredEnvironment("PLATFORM_SMOKE_SESSION_TOKEN_FILE");
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0)
    throw new Error("Smoke session token must not be empty");
  return value;
}

async function run(): Promise<void> {
  const accountId = requiredEnvironment("PLATFORM_SMOKE_ACCOUNT_ID");
  const mode = requiredEnvironment("PLATFORM_SMOKE_MODE");
  const repository = new PostgresPlatformRepository();
  const pool = createPlatformPool(requiredEnvironment("DATABASE_URL"));

  try {
    if (mode === "create") {
      const rawToken = await sessionToken();
      const session = await withPlatformTransaction(pool, async (client) => {
        await setAccountContext(client, accountId);
        return repository.createSession(client, {
          accountId,
          installationId: null,
          sessionDigest: digestOpaqueToken(rawToken),
          audience: "trackfinder",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
      });
      const decision = await new PolicyService(pool, repository).evaluate({
        accountId,
        sessionId: session.id,
        audience: "trackfinder",
        requiredModules: ["tf.search"],
        now: new Date(),
      });
      process.stdout.write(
        `${JSON.stringify({ sessionId: session.id, decision })}\n`,
      );
      return;
    }

    if (mode === "evaluate") {
      const decision = await new PolicyService(pool, repository).evaluate({
        accountId,
        sessionId: requiredEnvironment("PLATFORM_SMOKE_SESSION_ID"),
        audience: "trackfinder",
        requiredModules: ["tf.search"],
        now: new Date(),
      });
      process.stdout.write(`${JSON.stringify({ decision })}\n`);
      return;
    }

    throw new Error("PLATFORM_SMOKE_MODE must be create or evaluate");
  } finally {
    await pool.end();
  }
}

void run().catch(() => {
  process.stderr.write("Platform policy smoke failed\n");
  process.exitCode = 1;
});
