import { readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const MAX_FILE_BYTES = 1_073_741_824;
const DEFAULT_STORAGE_QUOTA_BYTES = 20 * 1_024 * 1_024 * 1_024;
const MAX_STORAGE_QUOTA_BYTES = 1_099_511_627_776;
const DEFAULT_FILE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
const DEFAULT_QUEUE_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_DOWNLOADER_EXECUTABLE = "/usr/local/bin/yt-dlp";
const MAX_SECRET_FILE_BYTES = 1_024;
const MAX_QUEUE_FILE_BYTES = 2_048;
const PRIVATE_SERVICE_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INLINE_CONFIGURATION_NAMES = [
  "TF_DOWNLOAD_QUEUE_REDIS_URL",
  "TF_DOWNLOAD_INTERNAL_AUTH_SECRET",
  "TF_DOWNLOAD_HEARTBEAT_SECRET",
] as const;

export interface TfDownloadWorkerConfig {
  readonly port: number;
  readonly queueRedisUrl: string;
  readonly internalAuthSecret: string;
  readonly heartbeatSecret: string;
  readonly heartbeatApiOrigin: string;
  readonly storageRoot: string;
  readonly downloaderExecutable: string;
  readonly version: string;
  readonly deployedAt?: string;
  readonly maxFileBytes: number;
  readonly storageQuotaBytes: number;
  readonly fileTtlMs: number;
  readonly sweepIntervalMs: number;
  readonly shutdownGraceMs: number;
  readonly queueProbeTimeoutMs: number;
}

export type TfDownloadWorkerFileReader = (
  filePath: string,
) => Promise<Buffer>;

function invalid(): never {
  throw new Error("invalid runtime configuration");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return value === undefined || value.length === 0 ? invalid() : value;
}

function optionalExactBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean {
  const value = env[name];
  if (value === undefined) return false;
  if (value !== "true") return invalid();
  return true;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) return invalid();
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid();
  }
  return value;
}

function isAbsoluteNormalized(value: string): boolean {
  if (path.posix.isAbsolute(value)) {
    return path.posix.normalize(value) === value;
  }
  if (path.win32.isAbsolute(value)) {
    return path.win32.normalize(value) === value;
  }
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) {
    return hostname
      .split(".")
      .every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return PRIVATE_SERVICE_NAME.test(hostname);
}

function parseHeartbeatOrigin(
  value: string,
  allowInsecure: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    value !== url.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return invalid();
  }
  if (url.protocol === "https:") return url.origin;
  if (
    url.protocol === "http:" &&
    allowInsecure &&
    isPrivateHostname(url.hostname)
  ) {
    return url.origin;
  }
  return invalid();
}

function parseQueueRedisUrl(
  value: string,
  allowInsecure: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    url.hostname === "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/(?:0|[1-9]|1[0-5])$/.test(url.pathname)
  ) {
    return invalid();
  }
  const port = Number(url.port || "6379");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return invalid();
  try {
    for (const credential of [url.username, url.password]) {
      const decoded = decodeURIComponent(credential);
      if (
        Buffer.byteLength(decoded, "utf8") > 512 ||
        /[\u0000-\u001f\u007f]/.test(decoded)
      ) {
        return invalid();
      }
    }
  } catch {
    return invalid();
  }
  if (url.protocol === "rediss:") return value;
  const sameNode =
    url.protocol === "redis:" &&
    allowInsecure &&
    url.hostname === "tf-download-redis" &&
    port === 6_379 &&
    url.pathname === "/0" &&
    url.username === "" &&
    url.password === "";
  return sameNode ? value : invalid();
}

function parseDeployedAt(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (value.length > 64 || match === null || Number.isNaN(Date.parse(value))) {
    return invalid();
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return invalid();
  }
  return value;
}

async function readBounded(
  reader: TfDownloadWorkerFileReader,
  filePath: string,
  maximumBytes: number,
): Promise<string> {
  if (!isAbsoluteNormalized(filePath)) return invalid();
  let bytes: Buffer;
  try {
    bytes = await reader(filePath);
  } catch {
    return invalid();
  }
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > maximumBytes
  ) {
    return invalid();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return invalid();
  }
}

function parseSecret(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= 32 && bytes <= 512 ? value : invalid();
}

export async function parseTfDownloadWorkerConfig(
  env: NodeJS.ProcessEnv,
  reader: TfDownloadWorkerFileReader = (filePath) => readFile(filePath),
): Promise<TfDownloadWorkerConfig> {
  if (INLINE_CONFIGURATION_NAMES.some((name) => name in env)) return invalid();

  const allowInsecureRedis = optionalExactBoolean(
    env,
    "TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS",
  );
  const allowInsecureHttp = optionalExactBoolean(
    env,
    "TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP",
  );
  const queueFile = required(env, "TF_DOWNLOAD_QUEUE_REDIS_URL_FILE");
  const commandFile = required(
    env,
    "TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE",
  );
  const heartbeatFile = required(
    env,
    "TF_DOWNLOAD_HEARTBEAT_SECRET_FILE",
  );
  if (new Set([queueFile, commandFile, heartbeatFile]).size !== 3) {
    return invalid();
  }

  const queueRedisUrl = parseQueueRedisUrl(
    await readBounded(reader, queueFile, MAX_QUEUE_FILE_BYTES),
    allowInsecureRedis,
  );
  const internalAuthSecret = parseSecret(
    await readBounded(reader, commandFile, MAX_SECRET_FILE_BYTES),
  );
  const heartbeatSecret = parseSecret(
    await readBounded(reader, heartbeatFile, MAX_SECRET_FILE_BYTES),
  );
  if (internalAuthSecret === heartbeatSecret) return invalid();

  const storageRoot = required(env, "TF_DOWNLOAD_STORAGE_ROOT");
  if (!isAbsoluteNormalized(storageRoot)) return invalid();
  const downloaderExecutable =
    env["TF_DOWNLOAD_YT_DLP_PATH"] ?? DEFAULT_DOWNLOADER_EXECUTABLE;
  if (!isAbsoluteNormalized(downloaderExecutable)) return invalid();

  const maxFileBytes = integer(
    env,
    "TF_DOWNLOAD_MAX_FILE_BYTES",
    MAX_FILE_BYTES,
    1,
    MAX_FILE_BYTES,
  );
  const storageQuotaBytes = integer(
    env,
    "TF_DOWNLOAD_STORAGE_QUOTA_BYTES",
    DEFAULT_STORAGE_QUOTA_BYTES,
    maxFileBytes,
    MAX_STORAGE_QUOTA_BYTES,
  );
  const version = env["APOLLO_API_VERSION"]?.trim() || "unknown";
  if (version.length > 128) return invalid();
  const deployedAt = parseDeployedAt(env["APOLLO_DEPLOYED_AT"]);

  return {
    port: integer(env, "PORT", 8_080, 1, 65_535),
    queueRedisUrl,
    internalAuthSecret,
    heartbeatSecret,
    heartbeatApiOrigin: parseHeartbeatOrigin(
      required(env, "TF_DOWNLOAD_HEARTBEAT_API_ORIGIN"),
      allowInsecureHttp,
    ),
    storageRoot,
    downloaderExecutable,
    version,
    ...(deployedAt === undefined ? {} : { deployedAt }),
    maxFileBytes,
    storageQuotaBytes,
    fileTtlMs: integer(
      env,
      "TF_DOWNLOAD_FILE_TTL_MS",
      DEFAULT_FILE_TTL_MS,
      60_000,
      DEFAULT_FILE_TTL_MS,
    ),
    sweepIntervalMs: integer(
      env,
      "TF_DOWNLOAD_SWEEP_INTERVAL_MS",
      DEFAULT_SWEEP_INTERVAL_MS,
      1_000,
      3_600_000,
    ),
    shutdownGraceMs: integer(
      env,
      "TF_DOWNLOAD_SHUTDOWN_GRACE_MS",
      DEFAULT_SHUTDOWN_GRACE_MS,
      1_000,
      300_000,
    ),
    queueProbeTimeoutMs: integer(
      env,
      "TF_DOWNLOAD_QUEUE_PROBE_TIMEOUT_MS",
      DEFAULT_QUEUE_PROBE_TIMEOUT_MS,
      100,
      10_000,
    ),
  };
}
