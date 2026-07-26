import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createTfDownloadFileSignature,
  DOWNLOAD_MAX_FILE_BYTES,
  downloadFileCommandSchema,
} from "@workspace/tf-download-contract";

const FILE_PATH = "/v1/files";
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const MAX_HEADERS_TIMEOUT_MS = 30_000;
const MAX_SECRET_BYTES = 512;
const PRIVATE_SERVICE_NAME =
  /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CANONICAL_NONCE = /^[0-9a-f]{64}$/;
const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;
const CONTENT_DISPOSITION =
  /^attachment; filename="[^"\\\r\n]{1,255}"; filename\*=UTF-8''[\x21-\x7e]{1,2295}$/;

type SecretReader = (path: string) => Promise<string>;

export interface TfDownloadWorkerClientConfig {
  readonly origin: string;
  readonly internalAuthSecret: string;
  readonly headersTimeoutMs: number;
}

export interface TfDownloadWorkerGateway {
  openFile(input: {
    readonly accountId: string;
    readonly jobId: string;
    readonly range?: { readonly start: number; readonly end?: number };
    readonly signal: AbortSignal;
  }): Promise<{
    readonly status: 200 | 206;
    readonly body: ReadableStream<Uint8Array>;
    readonly contentLength: number;
    readonly contentType: "audio/mpeg" | "audio/flac";
    readonly contentDisposition: string;
    readonly contentRange?: string;
  }>;
}

export interface TfDownloadWorkerClientDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly randomNonce?: () => string;
}

export type TfDownloadWorkerPublicStatus = 404 | 409 | 416 | 503;
export type TfDownloadWorkerErrorCode =
  | "file_not_found"
  | "file_not_ready"
  | "range_not_satisfiable"
  | "worker_unavailable";

function codeForStatus(
  status: TfDownloadWorkerPublicStatus,
): TfDownloadWorkerErrorCode {
  if (status === 404) return "file_not_found";
  if (status === 409) return "file_not_ready";
  if (status === 416) return "range_not_satisfiable";
  return "worker_unavailable";
}

export class TfDownloadWorkerError extends Error {
  readonly code: TfDownloadWorkerErrorCode;

  constructor(readonly status: TfDownloadWorkerPublicStatus) {
    super(codeForStatus(status));
    this.name = "TfDownloadWorkerError";
    this.code = codeForStatus(status);
  }
}

function unavailable(): TfDownloadWorkerError {
  return new TfDownloadWorkerError(503);
}

function invalidConfiguration(): never {
  throw new Error("invalid runtime configuration");
}

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return value === undefined ||
    value.length === 0 ||
    value !== value.trim()
    ? invalidConfiguration()
    : value;
}

function allowInsecureHttp(env: NodeJS.ProcessEnv): boolean {
  const value = env["TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP"];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  return invalidConfiguration();
}

function isLocalOrContainerHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    PRIVATE_SERVICE_NAME.test(hostname)
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
    isLocalOrContainerHostname(parsed.hostname)
  ) {
    return parsed.origin;
  }
  return invalidConfiguration();
}

async function loadSecret(
  env: NodeJS.ProcessEnv,
  readSecret: SecretReader,
): Promise<string> {
  const secretPath = requiredValue(
    env,
    "TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE",
  );
  try {
    const secret = (await readSecret(secretPath)).trim();
    const length = Buffer.byteLength(secret, "utf8");
    if (length < 32 || length > MAX_SECRET_BYTES) {
      return invalidConfiguration();
    }
    return secret;
  } catch {
    return invalidConfiguration();
  }
}

export async function parseTfDownloadWorkerClientConfig(
  env: NodeJS.ProcessEnv,
  readSecret: SecretReader = (path) => readFile(path, "utf8"),
): Promise<TfDownloadWorkerClientConfig> {
  return {
    origin: parseExactOrigin(
      requiredValue(env, "TF_DOWNLOAD_WORKER_ORIGIN"),
      allowInsecureHttp(env),
    ),
    internalAuthSecret: await loadSecret(env, readSecret),
    headersTimeoutMs: DEFAULT_HEADERS_TIMEOUT_MS,
  };
}

function boundedTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_HEADERS_TIMEOUT_MS
  ) {
    throw new Error("invalid TF download worker client configuration");
  }
  return value;
}

function parseLength(value: string | null): number | undefined {
  if (value === null || !CANONICAL_INTEGER.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) &&
    length >= 1 &&
    length <= DOWNLOAD_MAX_FILE_BYTES
    ? length
    : undefined;
}

function parseContentRange(
  value: string | null,
  contentLength: number,
): {
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly total: number;
} | undefined {
  if (value === null) return undefined;
  const match = /^bytes ((?:0|[1-9]\d*))-((?:0|[1-9]\d*))\/((?:[1-9]\d*))$/.exec(
    value,
  );
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    end >= total ||
    total > DOWNLOAD_MAX_FILE_BYTES ||
    end - start + 1 !== contentLength
  ) {
    return undefined;
  }
  return { value, start, end, total };
}

function boundedStreamingBody(
  body: ReadableStream<Uint8Array>,
  expectedLength: number,
  controller: AbortController,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  let complete = false;
  return new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          complete = true;
          cleanup();
          if (received !== expectedLength) {
            output.error(unavailable());
          } else {
            output.close();
          }
          return;
        }
        received += chunk.value.byteLength;
        if (
          received > expectedLength ||
          received > DOWNLOAD_MAX_FILE_BYTES
        ) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          cleanup();
          output.error(unavailable());
          return;
        }
        output.enqueue(chunk.value);
      } catch {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        cleanup();
        output.error(unavailable());
      }
    },
    async cancel(reason) {
      if (!complete) controller.abort();
      cleanup();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export class HttpTfDownloadWorkerClient
  implements TfDownloadWorkerGateway
{
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #randomUuid: () => string;
  readonly #randomNonce: () => string;
  readonly #headersTimeoutMs: number;

  constructor(
    private readonly config: TfDownloadWorkerClientConfig,
    dependencies: TfDownloadWorkerClientDependencies = {},
  ) {
    this.#headersTimeoutMs = boundedTimeout(config.headersTimeoutMs);
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? Date.now;
    this.#randomUuid = dependencies.randomUuid ?? randomUUID;
    this.#randomNonce =
      dependencies.randomNonce ?? (() => randomBytes(32).toString("hex"));
  }

  async openFile(
    input: Parameters<TfDownloadWorkerGateway["openFile"]>[0],
  ): ReturnType<TfDownloadWorkerGateway["openFile"]> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) controller.abort();
    const cleanup = (): void => {
      input.signal.removeEventListener("abort", abort);
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const command = downloadFileCommandSchema.parse({
        schemaVersion: 1,
        requestId: this.#randomUuid(),
        accountId: input.accountId,
        jobId: input.jobId,
        ...(input.range === undefined ? {} : { range: input.range }),
      });
      const rawBody = Buffer.from(JSON.stringify(command), "utf8");
      const timestamp = String(Math.floor(this.#now() / 1_000));
      const nonce = this.#randomNonce();
      if (!CANONICAL_NONCE.test(nonce)) throw unavailable();
      const signature = createTfDownloadFileSignature({
        method: "POST",
        path: FILE_PATH,
        timestamp,
        nonce,
        rawBody,
        secret: this.config.internalAuthSecret,
      });
      timeout = setTimeout(() => controller.abort(), this.#headersTimeoutMs);
      const response = await this.#fetch(
        new URL(FILE_PATH, this.config.origin),
        {
          method: "POST",
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-apollo-internal-timestamp": timestamp,
            "x-apollo-internal-nonce": nonce,
            "x-apollo-internal-signature": signature,
          },
          body: rawBody,
        },
      );
      clearTimeout(timeout);
      timeout = undefined;

      if ([404, 409, 416, 503].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        cleanup();
        throw new TfDownloadWorkerError(
          response.status as TfDownloadWorkerPublicStatus,
        );
      }
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);
        cleanup();
        throw unavailable();
      }

      const contentLength = parseLength(
        response.headers.get("content-length"),
      );
      const contentType = response.headers.get("content-type");
      const contentDisposition = response.headers.get(
        "content-disposition",
      );
      const contentRange = parseContentRange(
        response.headers.get("content-range"),
        contentLength ?? 0,
      );
      const expectedPartial = input.range !== undefined;
      if (
        contentLength === undefined ||
        (contentType !== "audio/mpeg" && contentType !== "audio/flac") ||
        contentDisposition === null ||
        !CONTENT_DISPOSITION.test(contentDisposition) ||
        response.headers.get("accept-ranges") !== "bytes" ||
        response.headers.get("cache-control") !== "private, no-store" ||
        response.body === null ||
        (response.status === 206) !== expectedPartial ||
        (response.status === 206 && contentRange === undefined) ||
        (response.status === 200 &&
          response.headers.get("content-range") !== null) ||
        (contentRange !== undefined &&
          (contentRange.start !== input.range?.start ||
            (input.range.end !== undefined &&
              contentRange.end !== input.range.end) ||
            (input.range?.end === undefined &&
              contentRange.end !== contentRange.total - 1)))
      ) {
        await response.body?.cancel().catch(() => undefined);
        cleanup();
        throw unavailable();
      }

      const body = boundedStreamingBody(
        response.body,
        contentLength,
        controller,
        cleanup,
      );
      return {
        status: response.status,
        body,
        contentLength,
        contentType,
        contentDisposition,
        ...(contentRange === undefined
          ? {}
          : { contentRange: contentRange.value }),
      };
    } catch (error) {
      if (timeout !== undefined) clearTimeout(timeout);
      if (error instanceof TfDownloadWorkerError) throw error;
      cleanup();
      throw unavailable();
    }
  }
}
