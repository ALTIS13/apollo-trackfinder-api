import {
  HttpTfDownloadWorkerClient,
  parseTfDownloadWorkerClientConfig,
  type TfDownloadWorkerGateway,
} from "./tf-download-worker-client.js";
import {
  assertDistinctTfCommandSecrets,
  HttpTfIntegrationsClient,
  parseTfIntegrationsClientConfig,
  type TfIntegrationsGateway,
} from "./tf-integrations-client.js";
import {
  HttpTfSearchClient,
  parseTfSearchClientConfig,
  type TfSearchGateway,
} from "./tf-search-client.js";

type SecretReader = (path: string) => Promise<string>;

export interface ApiGatewayRuntime {
  readonly integrationsGateway: TfIntegrationsGateway;
  readonly tracks: {
    readonly searchGateway: TfSearchGateway;
    readonly downloadWorkerGateway: TfDownloadWorkerGateway;
  };
}

export interface ApiGatewayRuntimeDependencies {
  readonly readSecret?: SecretReader;
}

export async function createApiGatewayRuntime(
  env: NodeJS.ProcessEnv,
  dependencies: ApiGatewayRuntimeDependencies = {},
): Promise<ApiGatewayRuntime> {
  try {
    const readSecret = dependencies.readSecret;
    const [integrationsConfig, searchConfig, downloadConfig] =
      await Promise.all([
        readSecret === undefined
          ? parseTfIntegrationsClientConfig(env)
          : parseTfIntegrationsClientConfig(env, readSecret),
        readSecret === undefined
          ? parseTfSearchClientConfig(env)
          : parseTfSearchClientConfig(env, readSecret),
        readSecret === undefined
          ? parseTfDownloadWorkerClientConfig(env)
          : parseTfDownloadWorkerClientConfig(env, readSecret),
      ]);

    assertDistinctTfCommandSecrets(
      integrationsConfig,
      searchConfig,
      downloadConfig,
    );

    return {
      integrationsGateway: new HttpTfIntegrationsClient(
        integrationsConfig,
      ),
      tracks: {
        searchGateway: new HttpTfSearchClient(searchConfig),
        downloadWorkerGateway: new HttpTfDownloadWorkerClient(
          downloadConfig,
        ),
      },
    };
  } catch {
    throw new Error("TF API startup failed");
  }
}
