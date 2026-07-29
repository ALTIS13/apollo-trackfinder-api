import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_TOKEN_FILE_BYTES = 4_096;
const MIN_TOKEN_BYTES = 32;
const INVALID_CONFIGURATION = "Admin dashboard configuration is invalid";

type Environment = Readonly<Record<string, string | undefined>>;

export type AdminDashboardTokenReader = (
  path: string,
  maximumBytes: number,
) => string;

function readBoundedRegularFile(path: string, maximumBytes: number): string {
  const descriptor = openSync(path, "r");
  try {
    const initialMetadata = fstatSync(descriptor);
    if (
      !initialMetadata.isFile() ||
      initialMetadata.size < 1 ||
      initialMetadata.size > maximumBytes
    ) {
      throw new Error(INVALID_CONFIGURATION);
    }

    const buffer = Buffer.alloc(maximumBytes + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.byteLength) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        totalBytes,
        buffer.byteLength - totalBytes,
        null,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }

    const finalMetadata = fstatSync(descriptor);
    if (
      totalBytes < 1 ||
      totalBytes > maximumBytes ||
      !finalMetadata.isFile() ||
      finalMetadata.size !== totalBytes
    ) {
      throw new Error(INVALID_CONFIGURATION);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, totalBytes),
    );
  } finally {
    closeSync(descriptor);
  }
}

export function loadAdminDashboardToken(
  environment: Environment,
  readFile: AdminDashboardTokenReader = readBoundedRegularFile,
): string | undefined {
  const path = environment["ADMIN_DASHBOARD_TOKEN_FILE"];
  const inlineToken = environment["ADMIN_DASHBOARD_TOKEN"];
  if (path === undefined) return undefined;

  try {
    if (path.length === 0 || inlineToken !== undefined) {
      throw new Error(INVALID_CONFIGURATION);
    }
    const source = readFile(path, MAX_TOKEN_FILE_BYTES);
    if (Buffer.byteLength(source, "utf8") > MAX_TOKEN_FILE_BYTES) {
      throw new Error(INVALID_CONFIGURATION);
    }
    const token = source.endsWith("\r\n")
      ? source.slice(0, -2)
      : source.endsWith("\n")
        ? source.slice(0, -1)
        : source;
    const tokenBytes = Buffer.byteLength(token, "utf8");
    if (
      tokenBytes < MIN_TOKEN_BYTES ||
      tokenBytes > MAX_TOKEN_FILE_BYTES ||
      token.includes("\n") ||
      token.includes("\r") ||
      /[\u0000-\u001f\u007f]/u.test(token)
    ) {
      throw new Error(INVALID_CONFIGURATION);
    }
    return token;
  } catch {
    throw new Error(INVALID_CONFIGURATION);
  }
}
