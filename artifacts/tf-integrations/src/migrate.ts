import { fileURLToPath } from "node:url";

import {
  createIntegrationsPool,
  runIntegrationsMigrations,
} from "@workspace/tf-integrations-db";

import { loadTfIntegrationsDatabaseUrl } from "./config.js";

async function migrate(): Promise<void> {
  const databaseUrl = await loadTfIntegrationsDatabaseUrl(process.env);
  const pool = createIntegrationsPool(databaseUrl, "migration");
  try {
    const result = await runIntegrationsMigrations(
      pool,
      fileURLToPath(new URL("./migrations", import.meta.url)),
    );
    process.stdout.write(
      `${JSON.stringify({
        event: "tf_integrations_migrations_complete",
        applied: result.applied.length,
        alreadyApplied: result.alreadyApplied.length,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

void migrate().catch(() => {
  process.stderr.write("TF integrations migration failed\n");
  process.exitCode = 1;
});
