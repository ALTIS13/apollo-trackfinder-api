import { TextDecoder } from "node:util";

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export type ProviderHttpFailureKind = "aborted" | "invalid_response";

export class ProviderHttpFailure extends Error {
  readonly kind: ProviderHttpFailureKind;

  constructor(kind: ProviderHttpFailureKind) {
    super("Provider HTTP request failed");
    this.name = "ProviderHttpFailure";
    this.kind = kind;
  }
}

export function cancelProviderResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // Disposal is best-effort and must not replace the sanitized failure.
  }
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    const cancellation = reader.cancel();
    void cancellation.catch(() => undefined);
  } catch {
    // Disposal is best-effort and must not replace the sanitized failure.
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal === undefined) return reader.read();
  if (signal.aborted) {
    cancelReader(reader);
    return Promise.reject(new ProviderHttpFailure("aborted"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cancelReader(reader);
      reject(new ProviderHttpFailure("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(new ProviderHttpFailure("invalid_response"));
      },
    );
  });
}

export async function fetchProviderResponse(
  fetchImplementation: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) {
    throw new ProviderHttpFailure("aborted");
  }

  const pending = Promise.resolve().then(() =>
    fetchImplementation(input, { ...init, signal }),
  );
  if (signal === undefined) return pending;

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      void pending.then(cancelProviderResponseBody, () => undefined);
      reject(new ProviderHttpFailure("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (response) => {
        if (settled) {
          cancelProviderResponseBody(response);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(new ProviderHttpFailure("aborted"));
      },
    );
  });
}

export async function readBoundedProviderJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) > MAX_PROVIDER_RESPONSE_BYTES)
  ) {
    cancelProviderResponseBody(response);
    throw new ProviderHttpFailure("invalid_response");
  }
  if (response.body === null) {
    throw new ProviderHttpFailure("invalid_response");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        cancelReader(reader);
        throw new ProviderHttpFailure("invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending aborted read can retain the lock until cancellation settles.
    }
  }

  if (signal?.aborted) {
    throw new ProviderHttpFailure("aborted");
  }
  try {
    const raw = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      size,
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    ) as unknown;
  } catch {
    throw new ProviderHttpFailure("invalid_response");
  }
}
