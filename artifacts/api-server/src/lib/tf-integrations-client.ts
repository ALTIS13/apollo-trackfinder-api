import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import {
  TF_INTEGRATIONS_COMMAND_PATH,
  tfIntegrationsCommandSchema,
  tfIntegrationsErrorResponseSchema,
  tfIntegrationsSuccessResponseSchema,
  type TfIntegrationsCommand,
  type TfIntegrationsErrorResponse,
  type TfIntegrationsSuccessResponse,
} from "@workspace/tf-integrations-contract";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const privateServiceNamePattern =
  /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type SecretReader = (path: string) => Promise<string>;
type GatewayCommand = TfIntegrationsCommand extends infer Command
  ? Command extends TfIntegrationsCommand
    ? Omit<Command, "schemaVersion" | "requestId">
    : never
  : never;
type GatewayResponse =
  | TfIntegrationsSuccessResponse
  | TfIntegrationsErrorResponse;
type ResponseFor<TCommand extends GatewayCommand> = Extract<
  GatewayResponse,
  { operation: TCommand["operation"] }
>;

export interface TfIntegrationsClientConfig {
  readonly origin: string;
  readonly internalAuthSecret: string;
  readonly timeoutMs: number;
}

export interface TfIntegrationsClientDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly randomNonce?: () => string;
}

interface TfCommandSecretConfig {
  readonly internalAuthSecret: string;
}

export interface TfIntegrationsGateway {
  execute<TCommand extends GatewayCommand>(
    command: TCommand,
  ): Promise<ResponseFor<TCommand>>;
}

export class TfIntegrationsUnavailableError extends Error {
  readonly code = "integrations_unavailable";

  constructor() {
    super("TF integrations unavailable");
    this.name = "TfIntegrationsUnavailableError";
  }
}

function invalidConfiguration(): never {
  throw new Error("invalid runtime configuration");
}

export function assertDistinctTfCommandSecrets(
  integrationsConfig: TfCommandSecretConfig,
  searchConfig: TfCommandSecretConfig,
): void {
  const integrationsSecret = Buffer.from(
    integrationsConfig.internalAuthSecret,
    "utf8",
  );
  const searchSecret = Buffer.from(searchConfig.internalAuthSecret, "utf8");
  if (
    integrationsSecret.byteLength === searchSecret.byteLength &&
    timingSafeEqual(integrationsSecret, searchSecret)
  ) {
    invalidConfiguration();
  }
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
  const path = requiredValue(
    env,
    "TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE",
  );
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

export async function parseTfIntegrationsClientConfig(
  env: NodeJS.ProcessEnv,
  readSecret: SecretReader = (path) => readFile(path, "utf8"),
): Promise<TfIntegrationsClientConfig> {
  const origin = parseExactOrigin(
    requiredValue(env, "TF_INTEGRATIONS_ORIGIN"),
    env["TF_INTEGRATIONS_ALLOW_INSECURE_HTTP"] === "true",
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
    throw new TfIntegrationsUnavailableError();
  }
  if (response.body === null) throw new TfIntegrationsUnavailableError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TfIntegrationsUnavailableError();
    }
    chunks.push(value);
  }

  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new TfIntegrationsUnavailableError();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort; the public failure remains sanitized.
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error("invalid TF integrations client configuration");
  }
  return value;
}

export class HttpTfIntegrationsClient implements TfIntegrationsGateway {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly randomNonce: () => string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: TfIntegrationsClientConfig,
    dependencies: TfIntegrationsClientDependencies = {},
  ) {
    this.timeoutMs = boundedTimeout(config.timeoutMs);
    this.fetchImplementation = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.randomUuid = dependencies.randomUuid ?? randomUUID;
    this.randomNonce =
      dependencies.randomNonce ??
      (() => randomBytes(32).toString("base64url"));
  }

  async execute<TCommand extends GatewayCommand>(
    input: TCommand,
  ): Promise<ResponseFor<TCommand>> {
    try {
      const command = tfIntegrationsCommandSchema.parse({
        ...input,
        schemaVersion: 1,
        requestId: this.randomUuid(),
      });
      const rawBody = Buffer.from(JSON.stringify(command), "utf8");
      const timestamp = String(Math.floor(this.now() / 1_000));
      const nonce = this.randomNonce();
      const signature = createSignedBodySignature({
        method: "POST",
        path: TF_INTEGRATIONS_COMMAND_PATH,
        timestamp,
        nonce,
        rawBody,
        secret: this.config.internalAuthSecret,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImplementation(
          new URL(TF_INTEGRATIONS_COMMAND_PATH, this.config.origin),
          {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              accept: "application/json",
              "accept-encoding": "identity",
              "content-type": "application/json",
              "x-apollo-internal-timestamp": timestamp,
              "x-apollo-internal-nonce": nonce,
              "x-apollo-internal-signature": signature,
            },
            body: rawBody.toString("utf8"),
          },
        );
        if (response.status !== 200) {
          await cancelResponseBody(response);
          throw new TfIntegrationsUnavailableError();
        }
        const value = await readBoundedJson(response);
        const success = tfIntegrationsSuccessResponseSchema.safeParse(value);
        const failure = tfIntegrationsErrorResponseSchema.safeParse(value);
        const parsed = success.success
          ? success.data
          : failure.success
            ? failure.data
            : undefined;
        if (
          parsed === undefined ||
          parsed.requestId !== command.requestId ||
          parsed.accountId !== command.accountId ||
          parsed.operation !== command.operation
        ) {
          throw new TfIntegrationsUnavailableError();
        }
        return parsed as ResponseFor<TCommand>;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof TfIntegrationsUnavailableError) throw error;
      throw new TfIntegrationsUnavailableError();
    }
  }
}
