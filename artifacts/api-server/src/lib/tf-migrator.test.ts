import { describe, expect, it, vi } from "vitest";

import { runTfMigrator, type TfMigratorDependencies } from "./tf-migrator.js";

const MIGRATOR_FILE = "/run/secrets/tf_migrator_database_url";
const BASELINE_FILE = "/run/secrets/tf_admin_database_url";
const DATABASE_URL = "postgres://migrator:private@db:5432/apollo_tf";

function dependencies(
  overrides: Partial<TfMigratorDependencies> = {},
): TfMigratorDependencies {
  return {
    readFile: vi.fn().mockResolvedValue(DATABASE_URL),
    createPool: vi.fn().mockReturnValue({
      end: vi.fn().mockResolvedValue(undefined),
    }),
    runMigrations: vi.fn().mockResolvedValue({
      applied: ["0002_tf_runtime_privileges.sql"],
      alreadyApplied: ["0001_tf_core_collections.sql"],
    }),
    baselineSchema: vi.fn().mockResolvedValue({
      applied: [
        "0001_tf_core_collections.sql",
        "0002_tf_runtime_privileges.sql",
      ],
      alreadyApplied: [],
    }),
    writeStdout: vi.fn(),
    ...overrides,
  } as unknown as TfMigratorDependencies;
}

describe("TF dedicated migrator", () => {
  it("runs normal migrations with only the migrator secret", async () => {
    const current = dependencies();

    await runTfMigrator(
      {
        args: [],
        env: { TF_MIGRATOR_DATABASE_URL_FILE: MIGRATOR_FILE },
      },
      current,
    );

    expect(current.readFile).toHaveBeenCalledWith(MIGRATOR_FILE, 4096);
    expect(current.createPool).toHaveBeenCalledWith(DATABASE_URL, "migration");
    expect(current.runMigrations).toHaveBeenCalledWith(
      expect.anything(),
      "/app/migrations",
    );
    expect(current.baselineSchema).not.toHaveBeenCalled();
    expect(current.writeStdout).toHaveBeenCalledWith(
      '{"event":"tf_migrations_complete","applied":1,"alreadyApplied":1}\n',
    );
  });

  it("runs the explicit baseline with only the baseline secret", async () => {
    const current = dependencies();

    await runTfMigrator(
      {
        args: ["--baseline-existing-startup-schema"],
        env: { TF_BASELINE_DATABASE_URL_FILE: BASELINE_FILE },
      },
      current,
    );

    expect(current.readFile).toHaveBeenCalledWith(BASELINE_FILE, 4096);
    expect(current.createPool).toHaveBeenCalledWith(DATABASE_URL, "migration");
    expect(current.baselineSchema).toHaveBeenCalledWith(
      expect.anything(),
      "/app/migrations",
    );
    expect(current.runMigrations).not.toHaveBeenCalled();
    expect(current.writeStdout).toHaveBeenCalledWith(
      '{"event":"tf_migrations_complete","applied":2,"alreadyApplied":0}\n',
    );
  });

  it.each([
    {
      label: "unknown argument",
      args: ["--unknown"],
      env: { TF_MIGRATOR_DATABASE_URL_FILE: MIGRATOR_FILE },
    },
    {
      label: "duplicate baseline argument",
      args: [
        "--baseline-existing-startup-schema",
        "--baseline-existing-startup-schema",
      ],
      env: { TF_BASELINE_DATABASE_URL_FILE: BASELINE_FILE },
    },
    {
      label: "baseline secret in normal mode",
      args: [],
      env: {
        TF_MIGRATOR_DATABASE_URL_FILE: MIGRATOR_FILE,
        TF_BASELINE_DATABASE_URL_FILE: BASELINE_FILE,
      },
    },
    {
      label: "migrator secret in baseline mode",
      args: ["--baseline-existing-startup-schema"],
      env: {
        TF_MIGRATOR_DATABASE_URL_FILE: MIGRATOR_FILE,
        TF_BASELINE_DATABASE_URL_FILE: BASELINE_FILE,
      },
    },
    {
      label: "missing normal secret",
      args: [],
      env: {},
    },
    {
      label: "missing baseline secret",
      args: ["--baseline-existing-startup-schema"],
      env: {},
    },
  ])("rejects $label before pool creation", async ({ args, env }) => {
    const current = dependencies();

    await expect(runTfMigrator({ args, env }, current)).rejects.toThrow(
      "TF migration failed",
    );

    expect(current.createPool).not.toHaveBeenCalled();
    expect(current.runMigrations).not.toHaveBeenCalled();
    expect(current.baselineSchema).not.toHaveBeenCalled();
    expect(current.writeStdout).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "unreadable",
      read: () =>
        Promise.reject(
          new Error(`cannot read ${MIGRATOR_FILE}: ${DATABASE_URL}`),
        ),
    },
    { label: "empty", read: () => Promise.resolve(" \r\n") },
    {
      label: "over the byte limit",
      read: () => Promise.resolve("x".repeat(4097)),
    },
    {
      label: "invalid UTF-8",
      read: () => Promise.reject(new Error("invalid UTF-8")),
    },
  ])("fails generically when the secret is $label", async ({ read }) => {
    const current = dependencies({
      readFile: vi.fn().mockImplementation(read),
    });

    const failure = runTfMigrator(
      {
        args: [],
        env: { TF_MIGRATOR_DATABASE_URL_FILE: MIGRATOR_FILE },
      },
      current,
    );

    await expect(failure).rejects.toThrow("TF migration failed");
    await expect(failure).rejects.not.toThrow(MIGRATOR_FILE);
    await expect(failure).rejects.not.toThrow(DATABASE_URL);
    expect(current.createPool).not.toHaveBeenCalled();
    expect(current.writeStdout).not.toHaveBeenCalled();
  });

  it("trims only the final loaded secret value", async () => {
    const current = dependencies({
      readFile: vi.fn().mockResolvedValue(` \n${DATABASE_URL}\r\n `),
    });

    await runTfMigrator(
      {
        args: [],
        env: { TF_MIGRATOR_DATABASE_URL_FILE: MIGRATOR_FILE },
      },
      current,
    );

    expect(current.createPool).toHaveBeenCalledWith(DATABASE_URL, "migration");
  });

  it("always closes the pool after migration success", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const current = dependencies({
      createPool: vi.fn().mockReturnValue({ end }),
    });

    await runTfMigrator(
      {
        args: [],
        env: { TF_MIGRATOR_DATABASE_URL_FILE: MIGRATOR_FILE },
      },
      current,
    );

    expect(end).toHaveBeenCalledOnce();
  });

  it("closes the pool and hides runner failures", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const current = dependencies({
      createPool: vi.fn().mockReturnValue({ end }),
      runMigrations: vi
        .fn()
        .mockRejectedValue(
          new Error(`select * from secret at ${DATABASE_URL}`),
        ),
    });

    const failure = runTfMigrator(
      {
        args: [],
        env: { TF_MIGRATOR_DATABASE_URL_FILE: MIGRATOR_FILE },
      },
      current,
    );

    await expect(failure).rejects.toThrow("TF migration failed");
    await expect(failure).rejects.not.toThrow(DATABASE_URL);
    expect(end).toHaveBeenCalledOnce();
    expect(current.writeStdout).not.toHaveBeenCalled();
  });

  it("fails generically and emits no success when pool cleanup fails", async () => {
    const current = dependencies({
      createPool: vi.fn().mockReturnValue({
        end: vi.fn().mockRejectedValue(new Error(DATABASE_URL)),
      }),
    });

    await expect(
      runTfMigrator(
        {
          args: [],
          env: { TF_MIGRATOR_DATABASE_URL_FILE: MIGRATOR_FILE },
        },
        current,
      ),
    ).rejects.toThrow("TF migration failed");
    expect(current.writeStdout).not.toHaveBeenCalled();
  });
});
