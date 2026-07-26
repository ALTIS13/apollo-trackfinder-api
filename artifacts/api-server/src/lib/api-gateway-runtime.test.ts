import { describe, expect, it, vi } from "vitest";

import {
  createApiGatewayRuntime,
  type ApiGatewayRuntime,
} from "./api-gateway-runtime.js";
import { HttpTfDownloadWorkerClient } from "./tf-download-worker-client.js";
import { HttpTfIntegrationsClient } from "./tf-integrations-client.js";
import { HttpTfSearchClient } from "./tf-search-client.js";

const INTEGRATIONS_SECRET = `integrations-${"i".repeat(32)}`;
const SEARCH_SECRET = `search-${"s".repeat(32)}`;
const DOWNLOAD_SECRET = `download-${"d".repeat(32)}`;
const INTEGRATIONS_SECRET_FILE = "/run/secrets/tf-integrations-command";
const SEARCH_SECRET_FILE = "/run/secrets/tf-search-command";
const DOWNLOAD_SECRET_FILE = "/run/secrets/tf-download-worker-command";

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    TF_INTEGRATIONS_ORIGIN: "https://integrations.apollot.ru",
    TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE: INTEGRATIONS_SECRET_FILE,
    TF_SEARCH_ORIGIN: "https://search.apollot.ru",
    TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: SEARCH_SECRET_FILE,
    TF_DOWNLOAD_WORKER_ORIGIN: "https://downloads.apollot.ru",
    TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE: DOWNLOAD_SECRET_FILE,
    ...overrides,
  };
}

function secretReader(
  overrides: Readonly<Record<string, string>> = {},
) {
  const secrets: Readonly<Record<string, string>> = {
    [INTEGRATIONS_SECRET_FILE]: INTEGRATIONS_SECRET,
    [SEARCH_SECRET_FILE]: SEARCH_SECRET,
    [DOWNLOAD_SECRET_FILE]: DOWNLOAD_SECRET,
    ...overrides,
  };
  return vi.fn(async (path: string) => {
    const secret = secrets[path];
    if (secret === undefined) throw new Error("missing secret");
    return secret;
  });
}

describe("API gateway startup boundary", () => {
  it("creates all production gateways and exposes the download client through tracks", async () => {
    const readSecret = secretReader();

    const runtime: ApiGatewayRuntime = await createApiGatewayRuntime(
      environment(),
      { readSecret },
    );

    expect(runtime.integrationsGateway).toBeInstanceOf(
      HttpTfIntegrationsClient,
    );
    expect(runtime.tracks.searchGateway).toBeInstanceOf(HttpTfSearchClient);
    expect(runtime.tracks.downloadWorkerGateway).toBeInstanceOf(
      HttpTfDownloadWorkerClient,
    );
    expect(readSecret.mock.calls.map(([path]) => path).sort()).toEqual(
      [
        INTEGRATIONS_SECRET_FILE,
        SEARCH_SECRET_FILE,
        DOWNLOAD_SECRET_FILE,
      ].sort(),
    );
  });

  it("fails generically when the download worker runtime config is missing", async () => {
    const invalid = environment();
    delete invalid["TF_DOWNLOAD_WORKER_ORIGIN"];

    await expect(
      createApiGatewayRuntime(invalid, { readSecret: secretReader() }),
    ).rejects.toThrow("TF API startup failed");
  });

  it("rejects a download secret shared with another command channel without leaking it", async () => {
    const caught = await createApiGatewayRuntime(environment(), {
      readSecret: secretReader({
        [DOWNLOAD_SECRET_FILE]: SEARCH_SECRET,
      }),
    }).catch((error: unknown) => error);

    expect(caught).toEqual(
      expect.objectContaining({ message: "TF API startup failed" }),
    );
    expect(String(caught)).not.toContain(SEARCH_SECRET);
  });
});
