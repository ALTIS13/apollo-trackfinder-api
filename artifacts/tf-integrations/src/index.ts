import { fileURLToPath } from "node:url";

import {
  createIntegrationsPool,
  PostgresProviderAccountRepository,
  probeIntegrationsDatabase,
  type ProviderAccountRepository,
} from "@workspace/tf-integrations-db";

import {
  createTfIntegrationsApp,
  createTfIntegrationsReadiness,
  type TfIntegrationsCommandService,
  type TfIntegrationsReadiness,
} from "./app.js";
import {
  parseTfIntegrationsConfig,
  type TfIntegrationsConfig,
} from "./config.js";
import {
  createTfIntegrationsShutdown,
  startTfIntegrationsHeartbeat,
  type TfIntegrationsHeartbeatHandle,
  type TfIntegrationsHeartbeatOptions,
} from "./heartbeat.js";
import { HmacInternalRequestAuthenticator } from "./internal-auth.js";
import { createSmokeFixtureProviders } from "./providers/smoke-fixtures.js";
import { SpotifyProvider } from "./providers/spotify.js";
import { YandexProvider } from "./providers/yandex.js";
import { TfIntegrationsService } from "./service.js";
import { ProviderTokenVault } from "./token-keyring.js";

type RuntimePool = ReturnType<typeof createIntegrationsPool>;

export interface TfIntegrationsRuntimeDependencies {
  readonly parseConfig: (
    env: NodeJS.ProcessEnv,
  ) => Promise<TfIntegrationsConfig>;
  readonly createPool: (databaseUrl: string) => RuntimePool;
  readonly createRepository: (pool: RuntimePool) => ProviderAccountRepository;
  readonly probeDatabase: (pool: RuntimePool) => Promise<boolean>;
  readonly createService: (
    config: TfIntegrationsConfig,
    repository: ProviderAccountRepository,
  ) => TfIntegrationsCommandService;
  readonly startHeartbeat: (
    options: TfIntegrationsHeartbeatOptions,
  ) => TfIntegrationsHeartbeatHandle;
}

export interface StartTfIntegrationsRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly dependencies?: Partial<TfIntegrationsRuntimeDependencies>;
  readonly registerSignals?: boolean;
}

export interface TfIntegrationsRuntime {
  readonly readiness: TfIntegrationsReadiness;
  shutdown(): Promise<void>;
}

const defaultDependencies: TfIntegrationsRuntimeDependencies = {
  parseConfig: parseTfIntegrationsConfig,
  createPool: (databaseUrl) => createIntegrationsPool(databaseUrl, "runtime"),
  createRepository: (pool) => new PostgresProviderAccountRepository(pool),
  probeDatabase: probeIntegrationsDatabase,
  createService: (config, repository) => {
    const providers = config.smokeFixtures
      ? createSmokeFixtureProviders()
      : {
          spotify: new SpotifyProvider({
            clientId: config.spotifyClientId,
            clientSecret: config.spotifyClientSecret,
            callbackUri: config.spotifyCallbackUri,
            fetch: globalThis.fetch,
          }),
          yandex: new YandexProvider({ fetch: globalThis.fetch }),
        };
    return new TfIntegrationsService({
      repository,
      tokenVault: new ProviderTokenVault(config.tokenKeyring),
      spotify: providers.spotify,
      yandex: providers.yandex,
    });
  },
  startHeartbeat: startTfIntegrationsHeartbeat,
};

function closeServer(
  server: ReturnType<ReturnType<typeof createTfIntegrationsApp>["listen"]>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function startTfIntegrationsRuntime(
  options: StartTfIntegrationsRuntimeOptions = {},
): Promise<TfIntegrationsRuntime> {
  const dependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  };
  const config = await dependencies.parseConfig(options.env ?? process.env);
  const pool = dependencies.createPool(config.databaseUrl);
  let listener:
    | ReturnType<ReturnType<typeof createTfIntegrationsApp>["listen"]>
    | undefined;
  let heartbeat: TfIntegrationsHeartbeatHandle | undefined;
  const commandAbortController = new AbortController();

  try {
    const repository = dependencies.createRepository(pool);
    const readiness = createTfIntegrationsReadiness({
      isMigrationCurrent: () => repository.isMigrationCurrent(),
      probeDatabase: () => dependencies.probeDatabase(pool),
    });
    if (!(await readiness.check())) {
      throw new Error("runtime is not ready");
    }

    const service = dependencies.createService(config, repository);
    const app = createTfIntegrationsApp({
      service,
      auth: new HmacInternalRequestAuthenticator({
        secret: config.internalAuthSecret,
      }),
      readiness,
      shutdownSignal: commandAbortController.signal,
    });
    listener = app.listen(config.port);
    await new Promise<void>((resolve, reject) => {
      listener?.once("listening", resolve);
      listener?.once("error", reject);
    });
    heartbeat = dependencies.startHeartbeat({
      apiOrigin: config.heartbeatApiOrigin,
      secret: config.heartbeatSecret,
      version: config.version,
      ...(config.deployedAt === undefined
        ? {}
        : { deployedAt: config.deployedAt }),
      ready: () => readiness.check(),
    });
    const shutdown = createTfIntegrationsShutdown({
      abortCommands: () => commandAbortController.abort(),
      closeListener: () => closeServer(listener!),
      heartbeat,
      closePool: () => pool.end(),
    });

    if (options.registerSignals !== false) {
      let signalHandled = false;
      const handleSignal = (): void => {
        if (signalHandled) return;
        signalHandled = true;
        process.removeListener("SIGTERM", handleSignal);
        process.removeListener("SIGINT", handleSignal);
        void shutdown().then(
          () => {
            process.exitCode = 0;
          },
          () => {
            process.stderr.write("TF integrations shutdown failed\n");
            process.exitCode = 1;
          },
        );
      };
      process.once("SIGTERM", handleSignal);
      process.once("SIGINT", handleSignal);
    }

    process.stdout.write("TF integrations listening\n");
    return { readiness, shutdown };
  } catch (error) {
    commandAbortController.abort();
    try {
      if (listener !== undefined) await closeServer(listener);
    } finally {
      try {
        if (heartbeat !== undefined) await heartbeat.stop();
      } finally {
        await pool.end();
      }
    }
    throw error;
  }
}

export async function runTfIntegrationsMain(
  options: StartTfIntegrationsRuntimeOptions = {},
): Promise<void> {
  try {
    await startTfIntegrationsRuntime(options);
  } catch {
    process.stderr.write("TF integrations startup failed\n");
    process.exitCode = 1;
  }
}

const mainPath = process.argv[1];
if (
  mainPath !== undefined &&
  fileURLToPath(import.meta.url).toLowerCase() === mainPath.toLowerCase()
) {
  void runTfIntegrationsMain();
}
