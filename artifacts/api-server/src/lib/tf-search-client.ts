import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import {
  TF_SEARCH_ARTIST_DISCOVERY_PATH,
  TF_SEARCH_COMMAND_PATH,
  TF_SEARCH_SUGGESTIONS_PATH,
  tfSearchArtistDiscoveryCommandSchema,
  tfSearchArtistDiscoveryResponseSchema,
  tfSearchCommandSchema,
  tfSearchResponseSchema,
  tfSearchSuggestionsCommandSchema,
  tfSearchSuggestionsResponseSchema,
  type TfSearchArtistDiscoveryCommand,
  type TfSearchArtistDiscoveryResponse,
  type TfSearchCommand,
  type TfSearchResponse,
  type TfSearchSuggestionsResponse,
} from "@workspace/tf-search-contract";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const privateServiceNamePattern =
  /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type SecretReader = (path: string) => Promise<string>;

export interface TfSearchClientConfig {
  readonly origin: string;
  readonly internalAuthSecret: string;
  readonly timeoutMs: number;
}

export interface ClientDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly randomNonce?: () => string;
}

export interface TfSearchGateway {
  search(
    input: Omit<TfSearchCommand, "schemaVersion" | "requestId">,
  ): Promise<TfSearchResponse>;
  discoverArtist(
    input: Omit<
      TfSearchArtistDiscoveryCommand,
      "schemaVersion" | "requestId"
    >,
  ): Promise<TfSearchArtistDiscoveryResponse>;
  suggestions(
    query: string,
    limit: number,
  ): Promise<TfSearchSuggestionsResponse>;
}

export class TfSearchUnavailableError extends Error {
  readonly code = "search_unavailable";

  constructor() {
    super("TF search unavailable");
    this.name = "TfSearchUnavailableError";
  }
}

function invalidConfiguration(): never {
  throw new Error("invalid runtime configuration");
}

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0
    ? invalidConfiguration()
    : value;
}

function isPrivateServiceHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    privateServiceNamePattern.test(hostname)
  );
}

function parseExactOrigin(value: string, allowInsecureHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidConfiguration();
  }
  if (
    value !== parsed.origin ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return invalidConfiguration();
  }
  if (parsed.protocol === "https:") return parsed.origin;
  if (
    parsed.protocol === "http:" &&
    allowInsecureHttp &&
    isPrivateServiceHostname(parsed.hostname)
  ) {
    return parsed.origin;
  }
  return invalidConfiguration();
}

async function loadSecret(
  env: NodeJS.ProcessEnv,
  readSecret: SecretReader,
): Promise<string> {
  const path = requiredValue(env, "TF_SEARCH_INTERNAL_AUTH_SECRET_FILE");
  try {
    const secret = (await readSecret(path)).trim();
    if (secret.length < 32 || secret.length > 512) {
      return invalidConfiguration();
    }
    return secret;
  } catch {
    return invalidConfiguration();
  }
}

export async function parseTfSearchClientConfig(
  env: NodeJS.ProcessEnv,
  readSecret: SecretReader = (path) => readFile(path, "utf8"),
): Promise<TfSearchClientConfig> {
  const origin = parseExactOrigin(
    requiredValue(env, "TF_SEARCH_ORIGIN"),
    env["TF_SEARCH_ALLOW_INSECURE_HTTP"] === "true",
  );
  const internalAuthSecret = await loadSecret(env, readSecret);
  return {
    origin,
    internalAuthSecret,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new TfSearchUnavailableError();
  }
  if (response.body === null) throw new TfSearchUnavailableError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TfSearchUnavailableError();
    }
    chunks.push(value);
  }

  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new TfSearchUnavailableError();
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error("invalid TF search client configuration");
  }
  return value;
}

export class HttpTfSearchClient implements TfSearchGateway {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly randomNonce: () => string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: TfSearchClientConfig,
    dependencies: ClientDependencies = {},
  ) {
    this.timeoutMs = boundedTimeout(config.timeoutMs);
    this.fetchImplementation = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.randomUuid = dependencies.randomUuid ?? randomUUID;
    this.randomNonce =
      dependencies.randomNonce ??
      (() => randomBytes(32).toString("base64url"));
  }

  search(
    input: Omit<TfSearchCommand, "schemaVersion" | "requestId">,
  ): Promise<TfSearchResponse> {
    return this.dispatch(
      TF_SEARCH_COMMAND_PATH,
      {
        schemaVersion: 1,
        requestId: this.randomUuid(),
        ...input,
      },
      tfSearchCommandSchema,
      tfSearchResponseSchema,
    );
  }

  suggestions(
    query: string,
    limit: number,
  ): Promise<TfSearchSuggestionsResponse> {
    return this.dispatch(
      TF_SEARCH_SUGGESTIONS_PATH,
      {
        schemaVersion: 1,
        requestId: this.randomUuid(),
        query,
        limit,
      },
      tfSearchSuggestionsCommandSchema,
      tfSearchSuggestionsResponseSchema,
    );
  }

  discoverArtist(
    input: Omit<
      TfSearchArtistDiscoveryCommand,
      "schemaVersion" | "requestId"
    >,
  ): Promise<TfSearchArtistDiscoveryResponse> {
    return this.dispatch(
      TF_SEARCH_ARTIST_DISCOVERY_PATH,
      {
        schemaVersion: 1,
        requestId: this.randomUuid(),
        ...input,
      },
      tfSearchArtistDiscoveryCommandSchema,
      tfSearchArtistDiscoveryResponseSchema,
    );
  }

  private async dispatch<
    TCommand extends { readonly requestId: string },
    TResponse extends { readonly requestId: string },
  >(
    path: string,
    candidate: unknown,
    commandSchema: { parse(value: unknown): TCommand },
    responseSchema: { safeParse(value: unknown): { success: boolean; data?: TResponse } },
  ): Promise<TResponse> {
    try {
      const command = commandSchema.parse(candidate);
      const rawBody = Buffer.from(JSON.stringify(command), "utf8");
      const timestamp = String(Math.floor(this.now() / 1_000));
      const nonce = this.randomNonce();
      const signature = createSignedBodySignature({
        method: "POST",
        path,
        timestamp,
        nonce,
        rawBody,
        secret: this.config.internalAuthSecret,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImplementation(
          new URL(path, this.config.origin),
          {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              "x-apollo-internal-timestamp": timestamp,
              "x-apollo-internal-nonce": nonce,
              "x-apollo-internal-signature": signature,
            },
            body: rawBody.toString("utf8"),
          },
        );
        if (response.status !== 200) throw new TfSearchUnavailableError();
        const parsed = responseSchema.safeParse(
          await readBoundedJson(response),
        );
        if (
          !parsed.success ||
          parsed.data === undefined ||
          parsed.data.requestId !== command.requestId
        ) {
          throw new TfSearchUnavailableError();
        }
        return parsed.data;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof TfSearchUnavailableError) throw error;
      throw new TfSearchUnavailableError();
    }
  }
}
