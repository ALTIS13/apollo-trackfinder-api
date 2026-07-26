import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";

import {
  downloadFileCommandSchema,
  downloadJobDataSchema,
  downloadJobResultSchema,
  type DownloadJobResult,
} from "@workspace/tf-download-contract";

import type {
  FileAuthenticationInput,
  FileRequestAuthenticator,
} from "./internal-auth.js";

const FILE_PATH = "/v1/files";
const BODY_LIMIT = 16 * 1024;
const HEADER_LIMIT = 8 * 1024;
const HEADER_COUNT_LIMIT = 64;

export interface DownloadFileJob {
  readonly id?: string;
  readonly data: unknown;
  readonly returnvalue: unknown;
  getState(): Promise<string>;
}

export interface DownloadFileJobs {
  getJob(jobId: string): Promise<DownloadFileJob | undefined>;
}

export interface OwnedDownloadFile {
  createReadStream(range: { readonly start: number; readonly end: number }):
    Readable;
  close(): Promise<void>;
}

export interface DownloadFileStorage {
  openOwnedFile(
    result: DownloadJobResult,
    signal?: AbortSignal,
  ): Promise<OwnedDownloadFile>;
}

export interface CreateTfDownloadWorkerAppOptions {
  readonly auth: FileRequestAuthenticator;
  readonly jobs: DownloadFileJobs;
  readonly storage: DownloadFileStorage;
  readonly ready: () => boolean | Promise<boolean>;
}

type FileHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

function setJsonHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
}

function json(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, string>>,
): void {
  if (response.destroyed || response.headersSent) return;
  setJsonHeaders(response);
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(bytes.byteLength));
  response.end(bytes);
}

function distinctHeader(
  request: IncomingMessage,
  name: string,
): FileAuthenticationInput["timestamp"] {
  const distinct = request.headersDistinct?.[name];
  if (distinct !== undefined) {
    return distinct.length === 1 ? distinct[0] : distinct;
  }
  return request.headers[name];
}

function exactTransport(request: IncomingMessage): boolean {
  const contentType = distinctHeader(request, "content-type");
  const contentEncoding = distinctHeader(request, "content-encoding");
  return (
    contentType === "application/json" &&
    (contentEncoding === undefined || contentEncoding === "identity")
  );
}

function boundedHeaders(request: IncomingMessage): boolean {
  if (request.rawHeaders.length / 2 > HEADER_COUNT_LIMIT) return false;
  let size = 0;
  for (const value of request.rawHeaders) {
    size += Buffer.byteLength(value, "utf8") + 2;
    if (size > HEADER_LIMIT) return false;
  }
  return true;
}

async function readRawBody(
  request: IncomingMessage,
): Promise<Buffer | undefined> {
  const contentLength = distinctHeader(request, "content-length");
  if (
    contentLength !== undefined &&
    (typeof contentLength !== "string" ||
      !/^\d+$/.test(contentLength) ||
      Number(contentLength) > BODY_LIMIT)
  ) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > BODY_LIMIT) return undefined;
      chunks.push(bytes);
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(chunks, size);
}

function parseJson(rawBody: Buffer): unknown | undefined {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
    ) as unknown;
  } catch {
    return undefined;
  }
}

function isRangeOnlyFailure(candidate: unknown): boolean {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !Object.prototype.hasOwnProperty.call(candidate, "range")
  ) {
    return false;
  }
  const withoutRange = { ...(candidate as Record<string, unknown>) };
  delete withoutRange["range"];
  return downloadFileCommandSchema.safeParse(withoutRange).success;
}

function contentDisposition(filename: string): string {
  const wellFormed = Array.from(filename, (character) => {
    const code = character.charCodeAt(0);
    return character.length === 1 && code >= 0xd800 && code <= 0xdfff
      ? "_"
      : character;
  }).join("");
  const fallback =
    Array.from(wellFormed, (character) =>
      character.length === 1 &&
      character.charCodeAt(0) >= 0x20 &&
      character.charCodeAt(0) <= 0x7e &&
      !`'";\\`.includes(character)
        ? character
        : "_",
    )
      .join("")
      .slice(0, 255) || "download";
  const encoded = encodeURIComponent(wellFormed).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function requestAbortScope(
  request: IncomingMessage,
  response: ServerResponse,
): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const abortOnClose = (): void => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", abort);
  response.once("close", abortOnClose);
  if (request.aborted || response.destroyed) abort();
  return {
    signal: controller.signal,
    dispose(): void {
      request.off("aborted", abort);
      response.off("close", abortOnClose);
    },
  };
}

async function dependencyReady(
  ready: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return (await ready()) === true;
  } catch {
    return false;
  }
}

async function handleFile(
  request: IncomingMessage,
  response: ServerResponse,
  options: CreateTfDownloadWorkerAppOptions,
): Promise<void> {
  if (!boundedHeaders(request) || !exactTransport(request)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  const rawBody = await readRawBody(request);
  if (rawBody === undefined) {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  const proof = options.auth.verifySignature({
    method: request.method ?? "",
    path: request.url ?? "",
    timestamp: distinctHeader(request, "x-apollo-internal-timestamp"),
    nonce: distinctHeader(request, "x-apollo-internal-nonce"),
    signature: distinctHeader(request, "x-apollo-internal-signature"),
    rawBody,
  });
  if (proof === undefined) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  const candidate = parseJson(rawBody);
  const parsed = downloadFileCommandSchema.safeParse(candidate);
  if (!parsed.success) {
    json(
      response,
      isRangeOnlyFailure(candidate) ? 416 : 400,
      {
        error: isRangeOnlyFailure(candidate)
          ? "range_not_satisfiable"
          : "invalid_request",
      },
    );
    return;
  }
  const command = parsed.data;
  const claim = options.auth.claim({
    accountId: command.accountId,
    nonce: proof.nonce,
  });
  if (claim !== "accepted") {
    json(
      response,
      claim === "capacity_exhausted" ? 503 : 401,
      {
        error:
          claim === "capacity_exhausted"
            ? "worker_unavailable"
            : "unauthorized",
      },
    );
    return;
  }

  let job: DownloadFileJob | undefined;
  try {
    job = await options.jobs.getJob(command.jobId);
  } catch {
    json(response, 503, { error: "worker_unavailable" });
    return;
  }
  if (job === undefined) {
    json(response, 404, { error: "file_not_found" });
    return;
  }
  const data = downloadJobDataSchema.safeParse(job.data);
  if (
    job.id !== command.jobId ||
    !data.success ||
    data.data.accountId !== command.accountId
  ) {
    json(response, 404, { error: "file_not_found" });
    return;
  }

  let state: string;
  try {
    state = await job.getState();
  } catch {
    json(response, 503, { error: "worker_unavailable" });
    return;
  }
  if (state === "waiting" || state === "active") {
    json(response, 409, { error: "file_not_ready" });
    return;
  }
  if (state !== "completed") {
    json(response, 404, { error: "file_not_found" });
    return;
  }
  const result = downloadJobResultSchema.safeParse(job.returnvalue);
  const expectedStorageKey = result.success
    ? `${command.jobId}.${result.data.mimeType === "audio/flac" ? "flac" : "mp3"}`
    : undefined;
  if (
    !result.success ||
    result.data.storageKey !== expectedStorageKey
  ) {
    json(response, 404, { error: "file_not_found" });
    return;
  }

  const start = command.range?.start ?? 0;
  const end = command.range?.end ?? result.data.fileSize - 1;
  if (
    start >= result.data.fileSize ||
    end >= result.data.fileSize ||
    end < start
  ) {
    json(response, 416, { error: "range_not_satisfiable" });
    return;
  }

  const scope = requestAbortScope(request, response);
  let owned: OwnedDownloadFile | undefined;
  try {
    owned = await options.storage.openOwnedFile(result.data, scope.signal);
  } catch {
    scope.dispose();
    json(response, 404, { error: "file_not_found" });
    return;
  }

  try {
    const partial = command.range !== undefined;
    const length = end - start + 1;
    response.statusCode = partial ? 206 : 200;
    response.setHeader("content-type", result.data.mimeType);
    response.setHeader("content-length", String(length));
    response.setHeader(
      "content-disposition",
      contentDisposition(result.data.filename),
    );
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("cache-control", "private, no-store");
    if (partial) {
      response.setHeader(
        "content-range",
        `bytes ${start}-${end}/${result.data.fileSize}`,
      );
    }
    await pipeline(
      owned.createReadStream({ start, end }),
      response,
      { signal: scope.signal },
    );
  } catch {
    if (!response.headersSent) {
      json(response, 404, { error: "file_not_found" });
    } else if (!response.destroyed) {
      response.destroy();
    }
  } finally {
    scope.dispose();
    await owned.close();
  }
}

export function createTfDownloadWorkerApp(
  options: CreateTfDownloadWorkerAppOptions,
): FileHandler {
  return (request, response) => {
    void (async () => {
      const target = request.url ?? "";
      if (request.method === "GET" && target === "/healthz") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && target === "/readyz") {
        const ready = await dependencyReady(options.ready);
        json(response, ready ? 200 : 503, {
          status: ready ? "ok" : "unavailable",
        });
        return;
      }
      if (request.method === "POST" && target === FILE_PATH) {
        await handleFile(request, response, options);
        return;
      }
      response.statusCode = 404;
      response.end();
    })().catch(() => {
      json(response, 503, { error: "worker_unavailable" });
    });
  };
}
