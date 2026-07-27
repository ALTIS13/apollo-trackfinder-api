import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

export const DOWNLOAD_QUEUE_NAME = "apollo-tf-downloads-v1";
export const DOWNLOAD_QUEUE_PREFIX = "{apollo-tf-downloads}";
export const DOWNLOAD_JOB_CANCELLATION_FIELD =
  "__apollo_tf_download_cancellation_v1";
export const DOWNLOAD_JOB_CANCELLATION_ARMED_SENTINEL =
  "apollo:tf-downloads:cancel-armed:v1";
export const DOWNLOAD_JOB_CANCELLATION_SENTINEL =
  "apollo:tf-downloads:cancel-requested:v1";
export const DOWNLOAD_MAX_FILE_BYTES = 1_073_741_824;

export interface DownloadQueueRedisConnection {
  readonly protocol: "redis:" | "rediss:";
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly username?: string;
  readonly password: string;
}

function rawRedisDatabasePath(value: string): string | undefined {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 1) return undefined;
  const pathStart = value.indexOf("/", schemeEnd + 3);
  if (pathStart < 0) return undefined;
  const suffix = value.slice(pathStart);
  const boundary = suffix.search(/[?#]/);
  return boundary < 0 ? suffix : suffix.slice(0, boundary);
}

export function parseDownloadQueueRedisConnection(
  value: string,
  allowInsecureSameNode: boolean,
): DownloadQueueRedisConnection | undefined {
  const rawDatabasePath = rawRedisDatabasePath(value);
  if (
    rawDatabasePath === undefined ||
    !/^\/(?:0|[1-9]|1[0-5])$/.test(rawDatabasePath)
  ) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.hostname === "" ||
    url.pathname !== rawDatabasePath ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }

  const port = Number(url.port || "6379");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;

  let username: string | undefined;
  let password: string;
  try {
    username =
      url.username === "" ? undefined : decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return undefined;
  }
  const usernameBytes =
    username === undefined ? 0 : new TextEncoder().encode(username).byteLength;
  const passwordBytes = new TextEncoder().encode(password).byteLength;
  if (
    usernameBytes > 512 ||
    (username !== undefined && /[\u0000-\u001f\u007f]/.test(username)) ||
    passwordBytes < 32 ||
    passwordBytes > 512 ||
    /[\u0000-\u001f\u007f]/.test(password)
  ) {
    return undefined;
  }

  const db = Number(rawDatabasePath.slice(1));
  const protocol =
    url.protocol === "redis:"
      ? "redis:"
      : url.protocol === "rediss:"
        ? "rediss:"
        : undefined;
  if (protocol === undefined) return undefined;
  if (
    protocol === "redis:" &&
    (!allowInsecureSameNode ||
      url.hostname !== "tf-download-redis" ||
      url.port !== "6379" ||
      db !== 0)
  ) {
    return undefined;
  }

  return {
    protocol,
    host: url.hostname,
    port,
    db,
    ...(username === undefined ? {} : { username }),
    password,
  };
}

export type DownloadAdmissionIntentState = "pending" | "confirmed";

export function getDownloadQueueAdmissionLedgerKey(
  toKey: (suffix: string) => string,
): string {
  return toKey("admission-intents");
}

export function getDownloadQueueJobHashKey(
  toKey: (suffix: string) => string,
  jobId: string,
): string {
  return toKey(jobId);
}

export function encodeDownloadAdmissionIntent(
  state: DownloadAdmissionIntentState,
  accountId: string,
): string {
  return `${state}:${canonicalUuidSchema.parse(accountId)}`;
}

export function parseDownloadAdmissionIntent(
  value: string,
): { state: DownloadAdmissionIntentState; accountId: string } | undefined {
  const match = /^(pending|confirmed):(.+)$/.exec(value);
  if (!match) return undefined;
  const accountId = canonicalUuidSchema.safeParse(match[2]);
  if (!accountId.success) return undefined;
  return {
    state: match[1] as DownloadAdmissionIntentState,
    accountId: accountId.data,
  };
}

const MAX_SOURCE_URL_LENGTH = 4_096;
const MAX_TRACK_ID_LENGTH = 4_096;
const MAX_ARTIST_LENGTH = 300;
const MAX_TITLE_LENGTH = 500;
const MAX_FILENAME_LENGTH = 255;

const allowedSourceHosts = [
  "youtube.com",
  "soundcloud.com",
  "bandcamp.com",
  "deezer.com",
  "dzcdn.net",
] as const;

const canonicalUuidSchema = z
  .string()
  .uuid()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const isRealIsoInstant = (value: string): boolean => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) {
    return false;
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offset,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offset !== "Z" &&
      (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))
  ) {
    return false;
  }

  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(hour, minute, second, 0);
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day &&
    calendarDate.getUTCHours() === hour &&
    calendarDate.getUTCMinutes() === minute &&
    calendarDate.getUTCSeconds() === second
  );
};
const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(isRealIsoInstant, "Expected a real ISO instant with a legal offset");
const boundedTrimmedStringSchema = (max: number) =>
  z.string().min(1).max(max).trim().min(1);

export const downloadQualitySchema = z.enum([
  "128",
  "192",
  "256",
  "320",
  "flac",
]);
export type DownloadQuality = z.infer<typeof downloadQualitySchema>;

export interface DownloadJobData {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly trackId: string;
  readonly artist: string;
  readonly title: string;
  readonly quality: DownloadQuality;
  readonly sourceUrl: string;
  readonly createdAt: string;
}

export interface DownloadJobResult {
  readonly schemaVersion: 1;
  readonly storageKey: string;
  readonly fileSize: number;
  readonly mimeType: "audio/mpeg" | "audio/flac";
  readonly filename: string;
  readonly completedAt: string;
}

export interface DownloadFileCommand {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly accountId: string;
  readonly jobId: string;
  readonly range?: { readonly start: number; readonly end?: number };
}

export interface TfDownloadFileSignatureInput {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly rawBody: Uint8Array;
  readonly secret: string | Uint8Array;
}

export function createTfDownloadFileSignature(
  input: TfDownloadFileSignatureInput,
): string {
  const bodyHash = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join("\n");
  return createHmac("sha256", input.secret).update(canonical).digest("hex");
}

const isAllowedSourceHost = (hostname: string): boolean =>
  allowedSourceHosts.some(
    (allowedHost) =>
      hostname === allowedHost || hostname.endsWith(`.${allowedHost}`),
  );

export const parseAllowedDownloadSourceUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== "" ||
      !isAllowedSourceHost(url.hostname)
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
};

const sourceUrlSchema = boundedTrimmedStringSchema(
  MAX_SOURCE_URL_LENGTH,
).refine((value) => parseAllowedDownloadSourceUrl(value) !== null, {
  message: "Expected an allowed HTTPS download source URL",
});

const downloadJobDataObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    accountId: canonicalUuidSchema,
    trackId: boundedTrimmedStringSchema(MAX_TRACK_ID_LENGTH),
    artist: boundedTrimmedStringSchema(MAX_ARTIST_LENGTH),
    title: boundedTrimmedStringSchema(MAX_TITLE_LENGTH),
    quality: downloadQualitySchema,
    sourceUrl: sourceUrlSchema,
    createdAt: timestampSchema,
  })
  .strict();

const storageKeySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|flac)$/,
  );

const filenameSchema = z
  .string()
  .min(1)
  .max(MAX_FILENAME_LENGTH)
  .regex(/^[^\r\n/\\\0]+$/);

const downloadJobResultObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    storageKey: storageKeySchema,
    fileSize: z.number().finite().int().min(1).max(DOWNLOAD_MAX_FILE_BYTES),
    mimeType: z.enum(["audio/mpeg", "audio/flac"]),
    filename: filenameSchema,
    completedAt: timestampSchema,
  })
  .strict()
  .refine(
    ({ storageKey, mimeType }) =>
      (storageKey.endsWith(".mp3") && mimeType === "audio/mpeg") ||
      (storageKey.endsWith(".flac") && mimeType === "audio/flac"),
    "Storage key extension must match MIME type",
  );

export const downloadJobStatusSchema = z.enum([
  "queued",
  "active",
  "completed",
  "failed",
]);
export type DownloadJobStatus = z.infer<typeof downloadJobStatusSchema>;

const byteRangeSchema = z
  .object({
    start: z
      .number()
      .finite()
      .int()
      .min(0)
      .max(DOWNLOAD_MAX_FILE_BYTES - 1),
    end: z
      .number()
      .finite()
      .int()
      .min(0)
      .max(DOWNLOAD_MAX_FILE_BYTES - 1)
      .optional(),
  })
  .strict()
  .refine(({ start, end }) => end === undefined || end >= start, {
    message: "Range end must not precede range start",
  });

const downloadFileCommandObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: canonicalUuidSchema,
    accountId: canonicalUuidSchema,
    jobId: canonicalUuidSchema,
    range: byteRangeSchema.optional(),
  })
  .strict();

export const downloadJobDataSchema: z.ZodType<DownloadJobData> =
  downloadJobDataObjectSchema;
export const downloadJobResultSchema: z.ZodType<DownloadJobResult> =
  downloadJobResultObjectSchema;
export const downloadFileCommandSchema: z.ZodType<DownloadFileCommand> =
  downloadFileCommandObjectSchema;
