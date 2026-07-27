import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  baselineTfStartupSchema,
  createTfMigrationReadinessProbe,
  runTfMigrations,
} from "./migrations.js";
import { createTfPool } from "./pool.js";

const TARGET_VALIDATION_ERROR =
  "TF PostgreSQL integration target validation failed";
const INTEGRATION_CLEANUP_ERROR = "TF PostgreSQL integration cleanup failed";
const TEST_DATABASE_PREFIX = "apollo_tf_test_";
const TEST_MARKER_PREFIX = "apollo.tf.integration-run:";
const TEST_RUN_ID = /^[a-z0-9](?:[a-z0-9_]{6,30}[a-z0-9])$/;

interface IntegrationEnvironment {
  readonly adminUrl: string | undefined;
  readonly migratorUrl: string | undefined;
  readonly runId: string | undefined;
  readonly runtimeUrl: string | undefined;
}

interface IntegrationTargetConfiguration {
  readonly databaseName: string;
  readonly marker: string;
  readonly runId: string;
  readonly urls: {
    readonly admin: string;
    readonly migrator: string;
    readonly runtime: string;
  };
}

interface IntegrationTargetIdentity {
  currentUser: string;
  databaseName: string;
  isSuperuser: boolean;
  marker: string | null;
  serverAddress: string | null;
  serverPort: number | null;
  serverVersion: number;
}

function targetValidationError(): Error {
  return new Error(TARGET_VALIDATION_ERROR);
}

function integrationCleanupError(): Error {
  return new Error(INTEGRATION_CLEANUP_ERROR);
}

function createIntegrationTargetConfiguration(
  environment: IntegrationEnvironment,
): IntegrationTargetConfiguration | undefined {
  if (
    !environment.adminUrl ||
    !environment.migratorUrl ||
    !environment.runtimeUrl ||
    !environment.runId
  ) {
    return undefined;
  }
  if (!TEST_RUN_ID.test(environment.runId)) {
    throw targetValidationError();
  }

  const databaseName = `${TEST_DATABASE_PREFIX}${environment.runId}`;
  if (Buffer.byteLength(databaseName, "ascii") > 63) {
    throw targetValidationError();
  }
  return {
    databaseName,
    marker: `${TEST_MARKER_PREFIX}${environment.runId}`,
    runId: environment.runId,
    urls: {
      admin: environment.adminUrl,
      migrator: environment.migratorUrl,
      runtime: environment.runtimeUrl,
    },
  };
}

function requireVerifiedIntegrationTarget(
  configuration: IntegrationTargetConfiguration,
  identities: readonly IntegrationTargetIdentity[],
): void {
  const expectedManagedUsers = [
    undefined,
    "apollo_tf_migrator",
    "apollo_tf_runtime",
  ] as const;
  const reference = identities[0];
  const valid =
    identities.length === expectedManagedUsers.length &&
    reference !== undefined &&
    reference.serverAddress !== null &&
    reference.serverPort !== null &&
    identities.every(
      (identity, index) =>
        identity.databaseName === configuration.databaseName &&
        identity.marker === configuration.marker &&
        identity.serverAddress === reference.serverAddress &&
        identity.serverPort === reference.serverPort &&
        identity.serverVersion >= 160_000 &&
        identity.serverVersion < 170_000 &&
        identity.currentUser.length > 0 &&
        (index === 0 || identity.currentUser === expectedManagedUsers[index]) &&
        identity.isSuperuser === (index === 0),
    );

  if (!valid) {
    throw targetValidationError();
  }
}

async function loadIntegrationTargetIdentity(
  client: PoolClient,
): Promise<IntegrationTargetIdentity> {
  const result = await client.query<IntegrationTargetIdentity>(`
    select
      current_user::text as "currentUser",
      current_database()::text as "databaseName",
      r.rolsuper as "isSuperuser",
      shobj_description(d.oid, 'pg_database')::text as marker,
      inet_server_addr()::text as "serverAddress",
      inet_server_port()::integer as "serverPort",
      current_setting('server_version_num')::integer as "serverVersion"
    from pg_database d
    join pg_roles r on r.rolname = current_user
    where d.datname = current_database()
  `);
  const identity = result.rows[0];
  if (!identity) {
    throw targetValidationError();
  }
  return identity;
}

type IntegrationPoolFactory = (
  connectionString: string,
  profile: "migration" | "runtime",
) => Pool;

interface IntegrationResourceState {
  physicalReleaseAttempted: boolean;
  physicalReleaseOccurred: boolean;
  poolEndAttempted: boolean;
  releaseError: Error | boolean | undefined;
}

interface IntegrationPoolResource {
  readonly pool: Pool;
  readonly state: IntegrationResourceState;
}

interface PinnedIntegrationResource extends IntegrationPoolResource {
  readonly client: PoolClient;
}

interface IntegrationCleanupResult {
  readonly failed: boolean;
  readonly reason?: unknown;
}

interface VerifiedIntegrationSessions {
  readonly admin: Pool;
  readonly migrator: Pool;
  readonly resources: readonly [
    PinnedIntegrationResource,
    PinnedIntegrationResource,
    PinnedIntegrationResource,
  ];
  readonly runtime: Pool;
}

function pinnedUseError(state: IntegrationResourceState): unknown {
  return state.releaseError instanceof Error
    ? state.releaseError
    : integrationCleanupError();
}

function assertPinnedResourceUsable(state: IntegrationResourceState): void {
  if (
    state.releaseError !== undefined ||
    state.physicalReleaseAttempted ||
    state.poolEndAttempted
  ) {
    throw pinnedUseError(state);
  }
}

function createPinnedClient(resource: PinnedIntegrationResource): PoolClient {
  return new Proxy(resource.client, {
    get(target, property, receiver) {
      if (property === "release") {
        return (error?: Error | boolean) => {
          if (
            error !== undefined &&
            error !== false &&
            resource.state.releaseError === undefined
          ) {
            resource.state.releaseError = error;
          }
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "query") {
        return (...args: unknown[]) => {
          try {
            assertPinnedResourceUsable(resource.state);
          } catch (error) {
            return Promise.reject(error);
          }
          return Reflect.apply(value, target, args);
        };
      }
      return (...args: unknown[]) => {
        assertPinnedResourceUsable(resource.state);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function createPinnedPool(resource: PinnedIntegrationResource): Pool {
  const pinnedClient = createPinnedClient(resource);
  return {
    connect: async () => {
      assertPinnedResourceUsable(resource.state);
      return pinnedClient;
    },
    query: ((...args: unknown[]) =>
      Reflect.apply(pinnedClient.query, pinnedClient, args)) as Pool["query"],
  } as Pool;
}

async function settleCleanupActions(
  actions: readonly (() => void | Promise<void>)[],
): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled(
    actions.map((action) =>
      (async () => {
        await action();
      })(),
    ),
  );
}

async function closeIntegrationResources(
  pinnedResources: readonly PinnedIntegrationResource[],
  poolResources: readonly IntegrationPoolResource[],
): Promise<IntegrationCleanupResult> {
  const releases = await settleCleanupActions(
    pinnedResources.map((resource) => () => {
      if (resource.state.physicalReleaseAttempted) return;
      resource.state.physicalReleaseAttempted = true;
      if (resource.state.releaseError === undefined) {
        resource.client.release();
      } else {
        resource.client.release(resource.state.releaseError);
      }
      resource.state.physicalReleaseOccurred = true;
    }),
  );
  const endings = await settleCleanupActions(
    poolResources.map((resource) => async () => {
      if (resource.state.poolEndAttempted) return;
      resource.state.poolEndAttempted = true;
      await resource.pool.end();
    }),
  );
  const rejection = [...releases, ...endings].find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  return rejection
    ? { failed: true, reason: rejection.reason }
    : { failed: false };
}

async function closePinnedResources(
  resources: readonly PinnedIntegrationResource[],
): Promise<IntegrationCleanupResult> {
  return closeIntegrationResources(resources, resources);
}

async function closeVerifiedIntegrationSessions(
  sessions: VerifiedIntegrationSessions,
  finalReset?: () => Promise<void>,
): Promise<void> {
  let hasPrimaryError = false;
  let primaryError: unknown;
  try {
    await finalReset?.();
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }
  const cleanup = await closePinnedResources(sessions.resources);
  if (hasPrimaryError) throw primaryError;
  if (cleanup.failed) throw integrationCleanupError();
}

async function openVerifiedIntegrationSessions(
  configuration: IntegrationTargetConfiguration,
  createPool: IntegrationPoolFactory = createTfPool,
): Promise<VerifiedIntegrationSessions> {
  const created: IntegrationPoolResource[] = [];
  const acquired: PinnedIntegrationResource[] = [];
  const createResource = (
    connectionString: string,
    profile: "migration" | "runtime",
  ): IntegrationPoolResource => {
    const resource = {
      pool: createPool(connectionString, profile),
      state: {
        physicalReleaseAttempted: false,
        physicalReleaseOccurred: false,
        poolEndAttempted: false,
        releaseError: undefined,
      },
    };
    created.push(resource);
    return resource;
  };

  try {
    const adminResource = createResource(configuration.urls.admin, "migration");
    const migratorResource = createResource(
      configuration.urls.migrator,
      "migration",
    );
    const runtimeResource = createResource(
      configuration.urls.runtime,
      "runtime",
    );
    const admin = {
      ...adminResource,
      client: await adminResource.pool.connect(),
    };
    acquired.push(admin);
    const migrator = {
      ...migratorResource,
      client: await migratorResource.pool.connect(),
    };
    acquired.push(migrator);
    const runtime = {
      ...runtimeResource,
      client: await runtimeResource.pool.connect(),
    };
    acquired.push(runtime);
    const identities = await Promise.all(
      acquired.map(({ client }) => loadIntegrationTargetIdentity(client)),
    );
    requireVerifiedIntegrationTarget(configuration, identities);
    const resources = acquired as [
      PinnedIntegrationResource,
      PinnedIntegrationResource,
      PinnedIntegrationResource,
    ];
    return {
      admin: createPinnedPool(resources[0]),
      migrator: createPinnedPool(resources[1]),
      resources,
      runtime: createPinnedPool(resources[2]),
    };
  } catch {
    await closeIntegrationResources(acquired, created);
    throw targetValidationError();
  }
}

async function withVerifiedIntegrationSessions<T>(
  configuration: IntegrationTargetConfiguration,
  operation: (sessions: VerifiedIntegrationSessions) => Promise<T>,
  createPool: IntegrationPoolFactory = createTfPool,
): Promise<T> {
  const sessions = await openVerifiedIntegrationSessions(
    configuration,
    createPool,
  );
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = await operation(sessions);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let closeError: unknown;
  try {
    await closeVerifiedIntegrationSessions(sessions);
  } catch (error) {
    closeError = error;
  }
  if (operationFailed) throw operationError;
  if (closeError !== undefined) throw closeError;
  return result as T;
}

const integrationTarget = createIntegrationTargetConfiguration({
  adminUrl: process.env["TF_TEST_ADMIN_DATABASE_URL"],
  migratorUrl: process.env["TF_TEST_MIGRATOR_DATABASE_URL"],
  runtimeUrl: process.env["TF_TEST_RUNTIME_DATABASE_URL"],
  runId: process.env["TF_TEST_RUN_ID"],
});
const integrationEnabled = integrationTarget !== undefined;
const legacySchemaSql = await readFile(
  fileURLToPath(
    new URL("../migrations/0001_tf_core_collections.sql", import.meta.url),
  ),
  "utf8",
);
const runtimePrivilegesSql = await readFile(
  fileURLToPath(
    new URL("../migrations/0002_tf_runtime_privileges.sql", import.meta.url),
  ),
  "utf8",
);
const migrationNames = [
  "0001_tf_core_collections.sql",
  "0002_tf_runtime_privileges.sql",
] as const;
const exactHistory = [
  {
    name: "0001_tf_core_collections.sql",
    checksum:
      "600de7ad9c9239b3f642c7a09f2195b386e0735aa6cd521d9dbc987b5485bcab",
  },
  {
    name: "0002_tf_runtime_privileges.sql",
    checksum:
      "a9bdbd8012fc237045aa7c57aeac4683a3baccfa66a1b7ec1956a2b1a4185c96",
  },
] as const;

interface RecordingPool {
  readonly connectCount: () => number;
  readonly endCount: () => number;
  readonly physicalReleaseCount: () => number;
  readonly pool: Pool;
  readonly queries: readonly string[];
  readonly releaseArguments: readonly (Error | boolean | undefined)[];
}

interface RecordingPoolFailures {
  readonly connect?: unknown;
  readonly end?: unknown;
  readonly release?: unknown;
}

function createRecordingPool(
  identity: IntegrationTargetIdentity,
  failures: RecordingPoolFailures = {},
): RecordingPool {
  let connects = 0;
  let ends = 0;
  let physicalReleases = 0;
  const queries: string[] = [];
  const releaseArguments: (Error | boolean | undefined)[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.includes("current_database()")
        ? { rows: [identity] }
        : { rows: [] };
    },
    release: (error?: Error | boolean) => {
      physicalReleases += 1;
      releaseArguments.push(error);
      if (failures.release !== undefined) throw failures.release;
    },
  } as unknown as PoolClient;
  const pool = {
    connect: () => {
      connects += 1;
      if (failures.connect !== undefined) throw failures.connect;
      return Promise.resolve(client);
    },
    end: () => {
      ends += 1;
      if (failures.end !== undefined) throw failures.end;
      return Promise.resolve();
    },
  } as unknown as Pool;

  return {
    connectCount: () => connects,
    endCount: () => ends,
    physicalReleaseCount: () => physicalReleases,
    pool,
    queries,
    releaseArguments,
  };
}

function validRecordingPools(): readonly [
  RecordingPool,
  RecordingPool,
  RecordingPool,
] {
  const common = {
    databaseName: "apollo_tf_test_task5guard1234",
    marker: "apollo.tf.integration-run:task5guard1234",
    serverAddress: "172.30.0.2",
    serverPort: 5432,
    serverVersion: 160_010,
  };
  return [
    createRecordingPool({
      ...common,
      currentUser: "task5_fixture_admin",
      isSuperuser: true,
    }),
    createRecordingPool({
      ...common,
      currentUser: "apollo_tf_migrator",
      isSuperuser: false,
    }),
    createRecordingPool({
      ...common,
      currentUser: "apollo_tf_runtime",
      isSuperuser: false,
    }),
  ];
}

describe("TF PostgreSQL integration target guard", () => {
  const environment = {
    adminUrl: "postgres://admin.invalid/ignored",
    migratorUrl: "postgres://migrator.invalid/ignored",
    runtimeUrl: "postgres://runtime.invalid/ignored",
    runId: "task5guard1234",
  };

  test("treats a missing run ID as incomplete configuration", () => {
    expect(
      createIntegrationTargetConfiguration({
        ...environment,
        runId: undefined,
      }),
    ).toBeUndefined();
  });

  test.each([
    "UPPERCASE",
    "contains-hyphen",
    "_leading",
    "trailing_",
    "seven77",
    "a".repeat(33),
  ])("rejects invalid configured run ID %j before connecting", (runId) => {
    expect(() =>
      createIntegrationTargetConfiguration({ ...environment, runId }),
    ).toThrowError("TF PostgreSQL integration target validation failed");
  });

  test("derives a distinct valid mutation for a maximum-length run ID", () => {
    const runId = `${"a".repeat(31)}x`;
    const mutation = alternateRunId(runId);

    expect(mutation).not.toBe(runId);
    expect(TEST_RUN_ID.test(mutation)).toBe(true);
  });

  test.each([
    {
      name: "wrong database",
      mutate: (identities: IntegrationTargetIdentity[]) => {
        identities[0]!.databaseName = "apollo_tf_test_other123";
      },
    },
    {
      name: "wrong marker",
      mutate: (identities: IntegrationTargetIdentity[]) => {
        identities[0]!.marker = "apollo.tf.integration-run:other123";
      },
    },
    {
      name: "cross-target URL",
      mutate: (identities: IntegrationTargetIdentity[]) => {
        identities[2]!.serverPort = 6543;
      },
    },
    {
      name: "wrong role",
      mutate: (identities: IntegrationTargetIdentity[]) => {
        identities[1]!.currentUser = "apollo_tf_runtime";
      },
    },
  ])("rejects $name identity before destructive work", ({ mutate }) => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const identities: IntegrationTargetIdentity[] = [
      {
        currentUser: "postgres",
        databaseName: "apollo_tf_test_task5guard1234",
        isSuperuser: true,
        marker: "apollo.tf.integration-run:task5guard1234",
        serverAddress: "172.30.0.2",
        serverPort: 5432,
        serverVersion: 160_010,
      },
      {
        currentUser: "apollo_tf_migrator",
        databaseName: "apollo_tf_test_task5guard1234",
        isSuperuser: false,
        marker: "apollo.tf.integration-run:task5guard1234",
        serverAddress: "172.30.0.2",
        serverPort: 5432,
        serverVersion: 160_010,
      },
      {
        currentUser: "apollo_tf_runtime",
        databaseName: "apollo_tf_test_task5guard1234",
        isSuperuser: false,
        marker: "apollo.tf.integration-run:task5guard1234",
        serverAddress: "172.30.0.2",
        serverPort: 5432,
        serverVersion: 160_010,
      },
    ];
    mutate(identities);

    expect(() =>
      requireVerifiedIntegrationTarget(configuration, identities),
    ).toThrowError("TF PostgreSQL integration target validation failed");
  });

  test("accepts any named PostgreSQL superuser for the admin session", () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const identities: IntegrationTargetIdentity[] = [
      {
        currentUser: "task5_fixture_admin",
        databaseName: "apollo_tf_test_task5guard1234",
        isSuperuser: true,
        marker: "apollo.tf.integration-run:task5guard1234",
        serverAddress: "172.30.0.2",
        serverPort: 5432,
        serverVersion: 160_010,
      },
      {
        currentUser: "apollo_tf_migrator",
        databaseName: "apollo_tf_test_task5guard1234",
        isSuperuser: false,
        marker: "apollo.tf.integration-run:task5guard1234",
        serverAddress: "172.30.0.2",
        serverPort: 5432,
        serverVersion: 160_010,
      },
      {
        currentUser: "apollo_tf_runtime",
        databaseName: "apollo_tf_test_task5guard1234",
        isSuperuser: false,
        marker: "apollo.tf.integration-run:task5guard1234",
        serverAddress: "172.30.0.2",
        serverPort: 5432,
        serverVersion: 160_010,
      },
    ];

    expect(() =>
      requireVerifiedIntegrationTarget(configuration, identities),
    ).not.toThrow();
  });

  test("pins one validated backend per role and never reacquires it", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const recordings = validRecordingPools();
    let nextPool = 0;

    const sessions = await openVerifiedIntegrationSessions(
      configuration,
      () => recordings[nextPool++]!.pool,
    );
    await sessions.admin.query("select 'admin-probe'");
    const migrationClient = await sessions.migrator.connect();
    await migrationClient.query("select 'migration-probe'");
    migrationClient.release();
    const repeatedClient = await sessions.migrator.connect();
    await repeatedClient.query("select 'same-migration-backend'");
    repeatedClient.release();

    expect(recordings.map((entry) => entry.connectCount())).toEqual([1, 1, 1]);
    expect(recordings[0].queries).toContain("select 'admin-probe'");
    expect(recordings[1].queries).toContain("select 'migration-probe'");
    expect(recordings[1].queries).toContain("select 'same-migration-backend'");
    expect(recordings.map((entry) => entry.physicalReleaseCount())).toEqual([
      0, 0, 0,
    ]);

    await closeVerifiedIntegrationSessions(sessions);
    expect(recordings.map((entry) => entry.physicalReleaseCount())).toEqual([
      1, 1, 1,
    ]);
    expect(recordings.map((entry) => entry.endCount())).toEqual([1, 1, 1]);
    expect(recordings.map((entry) => entry.releaseArguments)).toEqual([
      [undefined],
      [undefined],
      [undefined],
    ]);

    await closeVerifiedIntegrationSessions(sessions);
    expect(recordings.map((entry) => entry.physicalReleaseCount())).toEqual([
      1, 1, 1,
    ]);
    expect(recordings.map((entry) => entry.endCount())).toEqual([1, 1, 1]);
  });

  test("forwards the first poison error once and rejects every later pinned use", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const recordings = validRecordingPools();
    let nextPool = 0;
    const sessions = await openVerifiedIntegrationSessions(
      configuration,
      () => recordings[nextPool++]!.pool,
    );
    const migrationClient = await sessions.migrator.connect();
    const poisonError = new Error("uncertain migration cleanup");
    const laterError = new Error("must not replace the first poison");

    migrationClient.release(poisonError);
    migrationClient.release(laterError);

    await expect(
      migrationClient.query("select 'must-not-run-after-poison'"),
    ).rejects.toBe(poisonError);
    await expect(
      sessions.migrator.query("select 'pool-query-must-not-run-after-poison'"),
    ).rejects.toBe(poisonError);
    await expect(sessions.migrator.connect()).rejects.toBe(poisonError);
    expect(recordings.map((entry) => entry.connectCount())).toEqual([1, 1, 1]);

    await closeVerifiedIntegrationSessions(sessions);
    expect(recordings[1].physicalReleaseCount()).toBe(1);
    expect(recordings[1].releaseArguments).toEqual([poisonError]);
  });

  test("closes every pinned client and pool after final reset fails", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const recordings = validRecordingPools();
    let nextPool = 0;
    const sessions = await openVerifiedIntegrationSessions(
      configuration,
      () => recordings[nextPool++]!.pool,
    );
    const resetFailure = new Error("forced final reset failure");

    await expect(
      closeVerifiedIntegrationSessions(sessions, async () => {
        throw resetFailure;
      }),
    ).rejects.toBe(resetFailure);
    expect(recordings.map((entry) => entry.physicalReleaseCount())).toEqual([
      1, 1, 1,
    ]);
    expect(recordings.map((entry) => entry.endCount())).toEqual([1, 1, 1]);
  });

  test("closes acquired clients and pools when pinned validation fails", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const recordings = validRecordingPools();
    const invalidMigrator = createRecordingPool({
      currentUser: "apollo_tf_runtime",
      databaseName: configuration.databaseName,
      isSuperuser: false,
      marker: configuration.marker,
      serverAddress: "172.30.0.2",
      serverPort: 5432,
      serverVersion: 160_010,
    });
    const attempted = [recordings[0], invalidMigrator, recordings[2]] as const;
    let nextPool = 0;

    await expect(
      openVerifiedIntegrationSessions(
        configuration,
        () => attempted[nextPool++]!.pool,
      ),
    ).rejects.toThrowError(TARGET_VALIDATION_ERROR);
    expect(attempted.map((entry) => entry.physicalReleaseCount())).toEqual([
      1, 1, 1,
    ]);
    expect(attempted.map((entry) => entry.endCount())).toEqual([1, 1, 1]);
  });

  test("attempts every physical close after synchronous release and end failures", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const secret = "postgres://admin:do-not-expose@db.internal/apollo";
    const common = validRecordingPools();
    const recordings = [
      createRecordingPool(
        {
          currentUser: "task5_fixture_admin",
          databaseName: configuration.databaseName,
          isSuperuser: true,
          marker: configuration.marker,
          serverAddress: "172.30.0.2",
          serverPort: 5432,
          serverVersion: 160_010,
        },
        {
          release: new Error(`release failed for ${secret}`),
          end: new Error(`end failed for ${secret}`),
        },
      ),
      common[1],
      common[2],
    ] as const;
    let nextPool = 0;
    const sessions = await openVerifiedIntegrationSessions(
      configuration,
      () => recordings[nextPool++]!.pool,
    );

    let received: unknown;
    try {
      await closeVerifiedIntegrationSessions(sessions);
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toBe(
      "TF PostgreSQL integration cleanup failed",
    );
    expect((received as Error).message).not.toContain(secret);
    expect(recordings.map((entry) => entry.physicalReleaseCount())).toEqual([
      1, 1, 1,
    ]);
    expect(recordings.map((entry) => entry.endCount())).toEqual([1, 1, 1]);
  });

  test("treats an undefined synchronous close rejection as cleanup failure", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const recordings = validRecordingPools();
    let firstEndAttempts = 0;
    const firstPool = recordings[0].pool as Pool & {
      end: () => Promise<void>;
    };
    firstPool.end = () => {
      firstEndAttempts += 1;
      throw undefined;
    };
    let nextPool = 0;
    const sessions = await openVerifiedIntegrationSessions(
      configuration,
      () => recordings[nextPool++]!.pool,
    );

    await expect(
      closeVerifiedIntegrationSessions(sessions),
    ).rejects.toThrowError(INTEGRATION_CLEANUP_ERROR);
    expect(firstEndAttempts).toBe(1);
    expect(recordings.slice(1).map((entry) => entry.endCount())).toEqual([
      1, 1,
    ]);
  });

  test("preserves an operation error when physical cleanup also fails", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const cleanupFailure = new Error("forced cleanup failure");
    const valid = validRecordingPools();
    const recordings = [
      createRecordingPool(
        {
          currentUser: "task5_fixture_admin",
          databaseName: configuration.databaseName,
          isSuperuser: true,
          marker: configuration.marker,
          serverAddress: "172.30.0.2",
          serverPort: 5432,
          serverVersion: 160_010,
        },
        { end: cleanupFailure },
      ),
      valid[1],
      valid[2],
    ] as const;
    let nextPool = 0;
    const operationFailure = new Error("forced operation failure");

    await expect(
      withVerifiedIntegrationSessions(
        configuration,
        async () => {
          throw operationFailure;
        },
        () => recordings[nextPool++]!.pool,
      ),
    ).rejects.toBe(operationFailure);
    expect(recordings.map((entry) => entry.physicalReleaseCount())).toEqual([
      1, 1, 1,
    ]);
    expect(recordings.map((entry) => entry.endCount())).toEqual([1, 1, 1]);
  });

  test("preserves a final reset error when physical cleanup also fails", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const cleanupFailure = new Error("forced cleanup failure");
    const valid = validRecordingPools();
    const recordings = [
      createRecordingPool(
        {
          currentUser: "task5_fixture_admin",
          databaseName: configuration.databaseName,
          isSuperuser: true,
          marker: configuration.marker,
          serverAddress: "172.30.0.2",
          serverPort: 5432,
          serverVersion: 160_010,
        },
        { end: cleanupFailure },
      ),
      valid[1],
      valid[2],
    ] as const;
    let nextPool = 0;
    const sessions = await openVerifiedIntegrationSessions(
      configuration,
      () => recordings[nextPool++]!.pool,
    );
    const resetFailure = new Error("forced reset failure");

    await expect(
      closeVerifiedIntegrationSessions(sessions, async () => {
        throw resetFailure;
      }),
    ).rejects.toBe(resetFailure);
    expect(recordings.map((entry) => entry.physicalReleaseCount())).toEqual([
      1, 1, 1,
    ]);
    expect(recordings.map((entry) => entry.endCount())).toEqual([1, 1, 1]);
  });

  test("closes every returned pool when a later pool factory throws", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const recordings = validRecordingPools();
    let nextPool = 0;

    await expect(
      openVerifiedIntegrationSessions(configuration, () => {
        if (nextPool === 2) {
          throw new Error(
            "factory exposed postgres://runtime:secret@db.internal/apollo",
          );
        }
        return recordings[nextPool++]!.pool;
      }),
    ).rejects.toThrowError(TARGET_VALIDATION_ERROR);
    expect(recordings.map((entry) => entry.connectCount())).toEqual([0, 0, 0]);
    expect(recordings.map((entry) => entry.endCount())).toEqual([1, 1, 0]);
  });

  test("returns generic validation failure after partial acquisition cleanup errors", async () => {
    const configuration = createIntegrationTargetConfiguration(environment)!;
    const valid = validRecordingPools();
    const recordings = [
      createRecordingPool(
        {
          currentUser: "task5_fixture_admin",
          databaseName: configuration.databaseName,
          isSuperuser: true,
          marker: configuration.marker,
          serverAddress: "172.30.0.2",
          serverPort: 5432,
          serverVersion: 160_010,
        },
        {
          release: new Error("release exposed postgres://admin:secret@db"),
          end: new Error("end exposed postgres://admin:secret@db"),
        },
      ),
      createRecordingPool(
        {
          currentUser: "apollo_tf_migrator",
          databaseName: configuration.databaseName,
          isSuperuser: false,
          marker: configuration.marker,
          serverAddress: "172.30.0.2",
          serverPort: 5432,
          serverVersion: 160_010,
        },
        {
          connect: new Error("connect exposed postgres://migrator:secret@db"),
        },
      ),
      valid[2],
    ] as const;
    let nextPool = 0;

    await expect(
      openVerifiedIntegrationSessions(
        configuration,
        () => recordings[nextPool++]!.pool,
      ),
    ).rejects.toThrowError(TARGET_VALIDATION_ERROR);
    expect(recordings.map((entry) => entry.connectCount())).toEqual([1, 1, 0]);
    expect(recordings.map((entry) => entry.physicalReleaseCount())).toEqual([
      1, 0, 0,
    ]);
    expect(recordings.map((entry) => entry.endCount())).toEqual([1, 1, 1]);
  });
});

function databaseUrlFor(
  connectionString: string,
  databaseName: string,
): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function alternateRunId(runId: string): string {
  const suffix = runId.endsWith("x") ? "y" : "x";
  return runId.length < 32
    ? `${runId.slice(0, 31)}${suffix}`
    : `${runId.slice(0, -1)}${suffix}`;
}

describe
  .skipIf(!integrationEnabled)
  .sequential("TF PostgreSQL integration guard live proof", () => {
    test("rejects every real target mutation before DDL and preserves the external sentinel", async () => {
      if (!integrationTarget) throw targetValidationError();
      const alternateDatabaseName = `apollo_tf_alt_${integrationTarget.runId}`;
      const alternateUrls = {
        admin: databaseUrlFor(
          integrationTarget.urls.admin,
          alternateDatabaseName,
        ),
        migrator: databaseUrlFor(
          integrationTarget.urls.migrator,
          alternateDatabaseName,
        ),
        runtime: databaseUrlFor(
          integrationTarget.urls.runtime,
          alternateDatabaseName,
        ),
      };
      const expectedSentinel = `apollo.tf.guard-sentinel:${integrationTarget.runId}`;
      const reference =
        await openVerifiedIntegrationSessions(integrationTarget);
      const expectExternalSentinel = async (): Promise<void> => {
        const sentinel = await reference.admin.query<{ value: string }>(
          "select value from public.tf_integration_guard_sentinel where id = 1",
        );
        expect(sentinel.rows).toEqual([{ value: expectedSentinel }]);
      };

      try {
        await expectExternalSentinel();
        const wrongRunId = alternateRunId(integrationTarget.runId);
        const mutations = [
          {
            name: "wrong run ID",
            configuration: {
              ...integrationTarget,
              databaseName: `${TEST_DATABASE_PREFIX}${wrongRunId}`,
              marker: `${TEST_MARKER_PREFIX}${wrongRunId}`,
              runId: wrongRunId,
            },
          },
          {
            name: "wrong expected marker",
            configuration: {
              ...integrationTarget,
              marker: `${TEST_MARKER_PREFIX}${wrongRunId}`,
            },
          },
          {
            name: "wrong database target",
            configuration: {
              ...integrationTarget,
              urls: alternateUrls,
            },
          },
          {
            name: "cross-target runtime session",
            configuration: {
              ...integrationTarget,
              urls: {
                ...integrationTarget.urls,
                runtime: alternateUrls.runtime,
              },
            },
          },
          {
            name: "wrong migrator role",
            configuration: {
              ...integrationTarget,
              urls: {
                ...integrationTarget.urls,
                migrator: integrationTarget.urls.runtime,
              },
            },
          },
        ] as const;

        for (const mutation of mutations) {
          let destructiveCallbackReached = false;
          await expect(
            withVerifiedIntegrationSessions(
              mutation.configuration,
              async () => {
                destructiveCallbackReached = true;
                await reference.admin.query(
                  "drop table public.tf_integration_guard_sentinel",
                );
              },
            ),
            mutation.name,
          ).rejects.toThrowError(TARGET_VALIDATION_ERROR);
          expect(destructiveCallbackReached, mutation.name).toBe(false);
          await expectExternalSentinel();
        }
      } finally {
        await closeVerifiedIntegrationSessions(reference);
      }
    });
  });

let adminPool: Pool | undefined;
let migratorPool: Pool | undefined;
let runtimePool: Pool | undefined;
let verifiedSessions: VerifiedIntegrationSessions | undefined;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectContractError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect((error as Error & { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected contract error ${code}`);
}

async function expectPermissionDenied(sql: string): Promise<void> {
  try {
    await runtimePool!.query(sql);
  } catch (error) {
    expect(errorCode(error)).toBe("42501");
    return;
  }
  throw new Error("Expected PostgreSQL permission denial");
}

async function expectRuntimeCanaryIsolation(): Promise<void> {
  const privileges = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
  ] as const;
  const result = await adminPool!.query<{
    granted: boolean;
    privilege: string;
  }>(
    `select
       privilege,
       has_table_privilege(
         'apollo_tf_runtime',
         'public.runtime_canary',
         privilege
       ) as granted
     from unnest($1::text[]) with ordinality as requested(privilege, ordinal)
     order by ordinal`,
    [privileges],
  );
  if (
    result.rows.length !== privileges.length ||
    result.rows.some(
      (row, index) =>
        row.privilege !== privileges[index] || row.granted !== false,
    )
  ) {
    throw new Error("TF runtime canary privilege boundary failed");
  }

  for (const statement of [
    "select * from public.runtime_canary",
    "insert into public.runtime_canary (id) values (1)",
    "update public.runtime_canary set id = 2 where id = 1",
    "delete from public.runtime_canary where id = 1",
    "truncate table public.runtime_canary",
  ]) {
    await expectPermissionDenied(statement);
  }
}

function createSecondMigrationFailurePool(
  pool: Pool,
  exactMigrationSql: string,
): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "connect") {
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === "query") {
                return ((...args: unknown[]) => {
                  if (args[0] === exactMigrationSql) {
                    throw new Error("Injected TF migration failure");
                  }
                  return Reflect.apply(clientTarget.query, clientTarget, args);
                }) as PoolClient["query"];
              }
              const value = Reflect.get(
                clientTarget,
                clientProperty,
                clientReceiver,
              );
              return typeof value === "function"
                ? value.bind(clientTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function resetTfState(): Promise<void> {
  await adminPool!.query(`
    drop schema if exists apollo_tf cascade;
    drop table if exists
      public.playlist_tracks,
      public.playlists,
      public.liked_tracks,
      public.play_history,
      public.track_search_cache,
      public.runtime_canary,
      public.spotify_tokens,
      public.yandex_tokens
    cascade;
    revoke all privileges on schema public
      from apollo_tf_migrator, apollo_tf_runtime;
    grant usage, create on schema public to apollo_tf_migrator;
    grant usage on schema public to apollo_tf_runtime;
  `);
}

async function loadHistory(): Promise<
  Array<{ name: string; checksum: string }>
> {
  const result = await adminPool!.query<{ name: string; checksum: string }>(
    `select name, checksum
     from apollo_tf.schema_migrations
     order by name`,
  );
  return result.rows;
}

async function expectExactHistory(
  expected: readonly { name: string; checksum: string }[],
): Promise<void> {
  const history = await loadHistory();
  expect(history.map(({ name }) => name)).toEqual(
    expected.map(({ name }) => name),
  );
  expect(
    history.map(
      ({ checksum }, index) => checksum === expected[index]?.checksum,
    ),
  ).toEqual(expected.map(() => true));
}

async function expectNoHistoryRows(): Promise<void> {
  const relation = await adminPool!.query<{ name: string | null }>(
    "select to_regclass('apollo_tf.schema_migrations')::text as name",
  );
  if (relation.rows[0]?.name === null) return;
  const history = await adminPool!.query<{ count: number }>(
    "select count(*)::integer as count from apollo_tf.schema_migrations",
  );
  expect(history.rows[0]?.count).toBe(0);
}

async function createLegacySchema(pool: Pool = adminPool!): Promise<void> {
  await pool.query(legacySchemaSql);
}

describe
  .skipIf(!integrationEnabled)
  .sequential("TF PostgreSQL 16 migration integration", () => {
    beforeAll(async () => {
      if (!integrationTarget) throw targetValidationError();
      verifiedSessions =
        await openVerifiedIntegrationSessions(integrationTarget);
      adminPool = verifiedSessions.admin;
      migratorPool = verifiedSessions.migrator;
      runtimePool = verifiedSessions.runtime;

      const version = await adminPool.query<{ server_version_num: number }>(
        "select current_setting('server_version_num')::integer as server_version_num",
      );
      expect(version.rows[0]?.server_version_num).toBeGreaterThanOrEqual(
        160_000,
      );
      expect(version.rows[0]?.server_version_num).toBeLessThan(170_000);

      const roles = await adminPool.query<{
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolconnlimit: number;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolname: string;
        rolreplication: boolean;
        rolsuper: boolean;
        valid_until: string;
      }>(`
        select
          rolname,
          rolcanlogin,
          rolsuper,
          rolcreatedb,
          rolcreaterole,
          rolinherit,
          rolreplication,
          rolbypassrls,
          rolconnlimit,
          coalesce(rolvaliduntil::text, 'infinity') as valid_until
        from pg_roles
        where rolname in ('apollo_tf_migrator', 'apollo_tf_runtime')
        order by rolname
      `);
      expect(roles.rows).toEqual([
        {
          rolbypassrls: false,
          rolcanlogin: true,
          rolconnlimit: -1,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolname: "apollo_tf_migrator",
          rolreplication: false,
          rolsuper: false,
          valid_until: "infinity",
        },
        {
          rolbypassrls: false,
          rolcanlogin: true,
          rolconnlimit: -1,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolname: "apollo_tf_runtime",
          rolreplication: false,
          rolsuper: false,
          valid_until: "infinity",
        },
      ]);
    });

    beforeEach(async () => {
      await resetTfState();
    });

    afterAll(async () => {
      if (!verifiedSessions) return;
      await closeVerifiedIntegrationSessions(
        verifiedSessions,
        adminPool ? resetTfState : undefined,
      );
    });

    test("applies the exact manifest once and reports both migrations on repeat", async () => {
      await expect(runTfMigrations(migratorPool!)).resolves.toEqual({
        applied: [...migrationNames],
        alreadyApplied: [],
      });
      await expect(runTfMigrations(migratorPool!)).resolves.toEqual({
        applied: [],
        alreadyApplied: [...migrationNames],
      });
      await expectExactHistory(exactHistory);
    });

    test("reports exact readiness and allows runtime CRUD on all five active tables", async () => {
      await runTfMigrations(migratorPool!);
      await expect(
        createTfMigrationReadinessProbe(runtimePool!)(),
      ).resolves.toBe(true);

      const cases = [
        {
          insert:
            "insert into public.track_search_cache (cache_key, results, expires_at) values ('task5-cache', '[]'::jsonb, now() + interval '1 hour') returning id",
          select:
            "select cache_key as value from public.track_search_cache where id = $1",
          expected: "task5-cache",
          update:
            "update public.track_search_cache set cache_key = 'task5-cache-updated' where id = $1",
          remove: "delete from public.track_search_cache where id = $1",
        },
        {
          insert:
            "insert into public.play_history (session_id, track_id) values ('task5-session', 'task5-history') returning id",
          select:
            "select track_id as value from public.play_history where id = $1",
          expected: "task5-history",
          update:
            "update public.play_history set track_id = 'task5-history-updated' where id = $1",
          remove: "delete from public.play_history where id = $1",
        },
        {
          insert:
            "insert into public.liked_tracks (session_id, track_id) values ('task5-session', 'task5-liked') returning id",
          select:
            "select track_id as value from public.liked_tracks where id = $1",
          expected: "task5-liked",
          update:
            "update public.liked_tracks set track_id = 'task5-liked-updated' where id = $1",
          remove: "delete from public.liked_tracks where id = $1",
        },
        {
          insert:
            "insert into public.playlists (session_id, name) values ('task5-session', 'task5-playlist') returning id",
          select: "select name as value from public.playlists where id = $1",
          expected: "task5-playlist",
          update:
            "update public.playlists set name = 'task5-playlist-updated' where id = $1",
          remove: "delete from public.playlists where id = $1",
        },
        {
          insert:
            "insert into public.playlist_tracks (playlist_id, track_id) values (1, 'task5-track') returning id",
          select:
            "select track_id as value from public.playlist_tracks where id = $1",
          expected: "task5-track",
          update:
            "update public.playlist_tracks set track_id = 'task5-track-updated' where id = $1",
          remove: "delete from public.playlist_tracks where id = $1",
        },
      ] as const;

      for (const entry of cases) {
        const inserted = await runtimePool!.query<{ id: number }>(entry.insert);
        const id = inserted.rows[0]?.id;
        const selected = await runtimePool!.query<{ value: string }>(
          entry.select,
          [id],
        );
        expect(selected.rows).toEqual([{ value: entry.expected }]);
        await expect(
          runtimePool!.query(entry.update, [id]),
        ).resolves.toMatchObject({ rowCount: 1 });
        await expect(
          runtimePool!.query(entry.remove, [id]),
        ).resolves.toMatchObject({ rowCount: 1 });
      }
    });

    test("denies runtime DDL, truncate, history mutation, canary access, and setval", async () => {
      await runTfMigrations(migratorPool!);
      await adminPool!.query(
        "create table public.runtime_canary (id integer primary key)",
      );
      await expectRuntimeCanaryIsolation();

      for (const statement of [
        "create table public.runtime_ddl_probe (id integer)",
        "alter table public.track_search_cache add column forbidden integer",
        "drop table public.track_search_cache",
        "truncate table public.track_search_cache",
        "insert into apollo_tf.schema_migrations (name, checksum) values ('9999_forbidden.sql', repeat('0', 64))",
        "update apollo_tf.schema_migrations set checksum = repeat('0', 64)",
        "delete from apollo_tf.schema_migrations",
        "select setval('public.track_search_cache_id_seq', 100, true)",
      ]) {
        await expectPermissionDenied(statement);
      }
      await expectExactHistory(exactHistory);
    });

    test("detects an extra runtime canary DML privilege", async () => {
      await runTfMigrations(migratorPool!);
      await adminPool!.query(
        "create table public.runtime_canary (id integer primary key)",
      );
      await adminPool!.query(
        "grant insert on public.runtime_canary to apollo_tf_runtime",
      );

      await expect(expectRuntimeCanaryIsolation()).rejects.toThrowError(
        "TF runtime canary privilege boundary failed",
      );
    });

    test("rejects extra and checksum-drifted history", async () => {
      await runTfMigrations(migratorPool!);
      await adminPool!.query(
        "update apollo_tf.schema_migrations set checksum = repeat('0', 64) where name = $1",
        [migrationNames[0]],
      );
      await expectContractError(
        () => runTfMigrations(migratorPool!),
        "migration_history_mismatch",
      );
      await expect(
        createTfMigrationReadinessProbe(runtimePool!)(),
      ).resolves.toBe(false);

      await resetTfState();
      await runTfMigrations(migratorPool!);
      await adminPool!.query(
        "insert into apollo_tf.schema_migrations (name, checksum) values ('9999_extra.sql', repeat('f', 64))",
      );
      await expectContractError(
        () => runTfMigrations(migratorPool!),
        "migration_history_mismatch",
      );
      await expect(
        createTfMigrationReadinessProbe(runtimePool!)(),
      ).resolves.toBe(false);
    });

    test("rejects unmanaged managed tables without recording history", async () => {
      await adminPool!.query(
        "create table public.track_search_cache (id serial primary key)",
      );
      await expectContractError(
        () => runTfMigrations(migratorPool!),
        "migration_history_mismatch",
      );
      await expectNoHistoryRows();
    });

    test("requires a superuser for exact legacy adoption and transfers every managed owner", async () => {
      await createLegacySchema(migratorPool!);
      await expectContractError(
        () => baselineTfStartupSchema(migratorPool!),
        "migration_baseline_mismatch",
      );

      await resetTfState();
      await createLegacySchema();
      await expect(baselineTfStartupSchema(adminPool!)).resolves.toEqual({
        applied: [...migrationNames],
        alreadyApplied: [],
      });

      const owners = await adminPool!.query<{
        kind: string;
        name: string;
        owner: string;
      }>(`
        select 'schema'::text as kind, n.nspname::text as name, r.rolname::text as owner
        from pg_namespace n
        join pg_roles r on r.oid = n.nspowner
        where n.nspname = 'apollo_tf'
        union all
        select
          case when c.relkind = 'S' then 'sequence' else 'table' end,
          n.nspname || '.' || c.relname,
          r.rolname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_roles r on r.oid = c.relowner
        where (n.nspname = 'public' and c.relname in (
          'track_search_cache',
          'track_search_cache_id_seq',
          'play_history',
          'play_history_id_seq',
          'liked_tracks',
          'liked_tracks_id_seq',
          'playlists',
          'playlists_id_seq',
          'playlist_tracks',
          'playlist_tracks_id_seq'
        ))
        or (n.nspname = 'apollo_tf' and c.relname = 'schema_migrations')
        order by kind, name
      `);
      expect(owners.rows).toHaveLength(12);
      expect(
        owners.rows.every((entry) => entry.owner === "apollo_tf_migrator"),
      ).toBe(true);
      await expect(runTfMigrations(migratorPool!)).resolves.toEqual({
        applied: [],
        alreadyApplied: [...migrationNames],
      });
      await expectExactHistory(exactHistory);
    });

    test("preserves exact 0001 adoption when 0002 fails and resumes normally", async () => {
      await createLegacySchema();
      const failingPool = createSecondMigrationFailurePool(
        adminPool!,
        runtimePrivilegesSql,
      );

      await expect(baselineTfStartupSchema(failingPool)).rejects.toThrowError(
        "Injected TF migration failure",
      );
      await expectExactHistory([exactHistory[0]]);

      const owners = await adminPool!.query<{ owner: string }>(`
        select r.rolname::text as owner
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_roles r on r.oid = c.relowner
        where (
          n.nspname = 'public'
          and c.relname in (
            'track_search_cache',
            'track_search_cache_id_seq',
            'play_history',
            'play_history_id_seq',
            'liked_tracks',
            'liked_tracks_id_seq',
            'playlists',
            'playlists_id_seq',
            'playlist_tracks',
            'playlist_tracks_id_seq'
          )
        )
        or (n.nspname = 'apollo_tf' and c.relname = 'schema_migrations')
      `);
      expect(owners.rows).toHaveLength(11);
      expect(
        owners.rows.every((entry) => entry.owner === "apollo_tf_migrator"),
      ).toBe(true);

      await expect(runTfMigrations(migratorPool!)).resolves.toEqual({
        applied: [migrationNames[1]],
        alreadyApplied: [migrationNames[0]],
      });
      await expectExactHistory(exactHistory);
    });

    test("rejects every malformed legacy catalog without recording history", async () => {
      const mutations = [
        "drop table public.playlist_tracks",
        "alter table public.liked_tracks drop column title",
        "alter table public.playlists add column unexpected text",
        "alter table public.track_search_cache alter column results type text using results::text",
        "alter table public.playlist_tracks alter column position set default 1",
        "alter table public.liked_tracks drop constraint liked_tracks_session_id_track_id_key",
        "alter table public.play_history add constraint play_history_track_nonempty check (track_id <> '')",
        "drop index public.playlists_session_idx",
        "create index playlists_created_at_extra_idx on public.playlists (created_at)",
        "drop index public.playlists_session_idx; create index playlists_session_idx on public.playlists (created_at)",
      ] as const;

      for (const mutation of mutations) {
        await resetTfState();
        await createLegacySchema();
        await adminPool!.query(mutation);
        await expectContractError(
          () => baselineTfStartupSchema(adminPool!),
          "migration_baseline_mismatch",
        );
        await expectNoHistoryRows();
      }
    });

    test("creates no provider-token table or runtime grant", async () => {
      await runTfMigrations(migratorPool!);
      const result = await adminPool!.query<{
        provider_table_count: number;
        runtime_grant_count: number;
      }>(`
        select
          (
            select count(*)::integer
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'apollo_tf')
              and c.relname in ('spotify_tokens', 'yandex_tokens')
          ) as provider_table_count,
          (
            select count(*)::integer
            from information_schema.role_table_grants
            where grantee = 'apollo_tf_runtime'
              and table_name in ('spotify_tokens', 'yandex_tokens')
          ) as runtime_grant_count
      `);
      expect(result.rows).toEqual([
        { provider_table_count: 0, runtime_grant_count: 0 },
      ]);
    });
  });
