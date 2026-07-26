import { z } from "zod";

export const DOWNLOAD_QUEUE_NAME = "apollo-tf-downloads-v1";
export const DOWNLOAD_MAX_FILE_BYTES = 1_073_741_824;

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
