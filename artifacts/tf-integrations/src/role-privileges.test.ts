import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const migrationDirectory = join(
  repositoryRoot,
  "lib",
  "tf-integrations-db",
  "migrations",
);
const roleInitPath = join(
  repositoryRoot,
  "artifacts",
  "tf-integrations",
  "container",
  "init-roles.sh",
);

describe("tf-integrations runtime database privileges", () => {
  it("uses an additive grant migration with SELECT-only history and explicit provider DML", async () => {
    const names = (await readdir(migrationDirectory)).sort();
    expect(names).toContain("0004_runtime_privileges.sql");

    const [roleInit, privileges] = await Promise.all([
      readFile(roleInitPath, "utf8"),
      readFile(
        join(migrationDirectory, "0004_runtime_privileges.sql"),
        "utf8",
      ),
    ]);

    expect(roleInit).not.toMatch(
      /alter default privileges[\s\S]*grant\s+select,\s*insert,\s*update,\s*delete\s+on tables/i,
    );
    expect(privileges).toMatch(
      /alter default privileges for role apollo_tf_integrations_migrator[\s\S]*revoke\s+select,\s*insert,\s*update,\s*delete\s+on tables\s+from apollo_tf_integrations_runtime/i,
    );
    expect(privileges).toMatch(
      /revoke all privileges on all tables in schema apollo_tf_integrations\s+from apollo_tf_integrations_runtime/i,
    );
    expect(privileges).toMatch(
      /grant select,\s*insert,\s*update,\s*delete\s+on table apollo_tf_integrations\.provider_accounts\s+to apollo_tf_integrations_runtime/i,
    );
    expect(privileges).toMatch(
      /grant select on table apollo_tf_integrations\.schema_migrations\s+to apollo_tf_integrations_runtime/i,
    );
    expect(privileges).not.toMatch(
      /grant\s+(?:insert|update|delete|truncate)[^;]*schema_migrations/i,
    );
  });

  it("bounds role password files and every PostgreSQL bootstrap wait", async () => {
    const roleInit = await readFile(roleInitPath, "utf8");

    expect(roleInit).toMatch(
      /read_secret\(\)[\s\S]*wc -c[\s\S]*-lt "\$minimum"[\s\S]*-gt "\$maximum"/i,
    );
    expect(roleInit).toMatch(
      /read_secret \/run\/secrets\/tf_integrations_migrator_password 1 512/i,
    );
    expect(roleInit).toMatch(
      /read_secret \/run\/secrets\/tf_integrations_runtime_password 1 512/i,
    );
    expect(roleInit).toMatch(/PGCONNECT_TIMEOUT=10/i);
    expect(roleInit).toMatch(/statement_timeout=30000/i);
    expect(roleInit).toMatch(/lock_timeout=5000/i);
    expect(roleInit).not.toMatch(/cat "\$1"\s*\n\s*if \[ -z/i);
  });
});
