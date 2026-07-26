import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_MAX_FILE_BYTES,
  DOWNLOAD_QUEUE_PREFIX,
  DOWNLOAD_QUEUE_NAME,
  downloadFileCommandSchema,
  encodeDownloadAdmissionIntent,
  getDownloadQueueAdmissionLedgerKey,
  parseDownloadAdmissionIntent,
  downloadJobDataSchema,
  downloadJobResultSchema,
  downloadJobStatusSchema,
  downloadQualitySchema,
  parseAllowedDownloadSourceUrl,
} from "./index";

const ACCOUNT_ID = "a0000000-0000-4000-8000-000000000001";
const REQUEST_ID = "b0000000-0000-4000-8000-000000000002";
const JOB_ID = "c0000000-0000-4000-8000-000000000003";
const CREATED_AT = "2026-07-26T00:00:00.000Z";
const MAX_SOURCE_URL = `https://youtube.com/${"x".repeat(4_076)}`;
const FORBIDDEN_SOURCE_URLS = [
  "http://youtube.com/watch?v=example",
  "https://user:pass@youtube.com/watch?v=example",
  "https://youtube.com:444/watch?v=example",
  "https://youtube.com/watch?v=example#fragment",
  "https://youtube.com.evil.test/watch?v=example",
  "https://notyoutube.com/watch?v=example",
  "https://yоutube.com/watch?v=example",
  "not a URL",
] as const;

const downloadJobData = {
  schemaVersion: 1,
  accountId: ACCOUNT_ID,
  trackId: "yt_example",
  artist: "Artist",
  title: "Title",
  quality: "320",
  sourceUrl: "https://www.youtube.com/watch?v=example",
  createdAt: CREATED_AT,
} as const;

const downloadJobResult = {
  schemaVersion: 1,
  storageKey: `${JOB_ID}.mp3`,
  fileSize: DOWNLOAD_MAX_FILE_BYTES,
  mimeType: "audio/mpeg",
  filename: "Artist - Title.mp3",
  completedAt: CREATED_AT,
} as const;

describe("tf download contract", () => {
  it("exports the versioned queue constants", () => {
    expect(DOWNLOAD_QUEUE_NAME).toBe("apollo-tf-downloads-v1");
    expect(DOWNLOAD_MAX_FILE_BYTES).toBe(1_073_741_824);
    expect(DOWNLOAD_QUEUE_PREFIX).toBe("{apollo-tf-downloads}");
    expect(DOWNLOAD_QUEUE_PREFIX).toMatch(/^\{[^{}]+\}$/);
  });

  it("encodes owner-bound admission intents through the queue's own prefix", () => {
    expect(
      getDownloadQueueAdmissionLedgerKey(
        (suffix) => `tenant:{apollo}:${suffix}`,
      ),
    ).toBe("tenant:{apollo}:admission-intents");
    expect(encodeDownloadAdmissionIntent("pending", ACCOUNT_ID)).toBe(
      `pending:${ACCOUNT_ID}`,
    );
    expect(parseDownloadAdmissionIntent(`confirmed:${ACCOUNT_ID}`)).toEqual({
      state: "confirmed",
      accountId: ACCOUNT_ID,
    });
    expect(parseDownloadAdmissionIntent(`pending:${ACCOUNT_ID}:extra`)).toBe(
      undefined,
    );
  });

  it("accepts every download quality", () => {
    expect(downloadQualitySchema.options).toEqual([
      "128",
      "192",
      "256",
      "320",
      "flac",
    ]);
  });

  it("parses only strict bounded download job data", () => {
    expect(downloadJobDataSchema.parse(downloadJobData)).toEqual(
      downloadJobData,
    );
    expect(() =>
      downloadJobDataSchema.parse({
        schemaVersion: 1,
        accountId: ACCOUNT_ID,
        trackId: "yt_example",
        artist: "Artist",
        title: "Title",
        quality: "320",
        sourceUrl: "https://www.youtube.com/watch?v=example",
        createdAt: "2026-07-26T00:00:00.000Z",
        unexpected: true,
      }),
    ).toThrow();
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        accountId: ACCOUNT_ID.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({ ...downloadJobData, trackId: "" })
        .success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        trackId: "x".repeat(4_097),
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        artist: " ".repeat(301),
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        title: " ".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        sourceUrl: `https://youtube.com/${"x".repeat(4_080)}`,
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        createdAt: "not-a-date",
      }).success,
    ).toBe(false);
  });

  it("rejects raw download job strings that exceed bounds before trimming", () => {
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        trackId: `${"x".repeat(4_096)} `,
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        artist: `${"x".repeat(300)} `,
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        title: `${"x".repeat(500)} `,
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        sourceUrl: ` ${MAX_SOURCE_URL}`,
      }).success,
    ).toBe(false);
  });

  it("accepts exact string bounds and rejects the next value", () => {
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        trackId: "x".repeat(4_096),
        artist: "x".repeat(300),
        title: "x".repeat(500),
        sourceUrl: MAX_SOURCE_URL,
      }).success,
    ).toBe(true);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        trackId: "x".repeat(4_097),
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        artist: "x".repeat(301),
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        title: "x".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        sourceUrl: `${MAX_SOURCE_URL}x`,
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        filename: "x".repeat(255),
      }).success,
    ).toBe(true);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        filename: "x".repeat(256),
      }).success,
    ).toBe(false);
  });

  it("rejects timestamps that are not real ISO instants", () => {
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        createdAt: "2026-07-26T00:00:00+99:99",
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        createdAt: "2026-02-30T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        completedAt: "2026-07-26T00:00:00-99:99",
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        completedAt: "2026-02-30T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      downloadJobDataSchema.safeParse({
        ...downloadJobData,
        createdAt: "2026-07-26T00:00:00+23:59",
      }).success,
    ).toBe(true);
  });

  it("rejects every forbidden source URL through job data parsing", () => {
    for (const sourceUrl of FORBIDDEN_SOURCE_URLS) {
      expect(
        downloadJobDataSchema.safeParse({ ...downloadJobData, sourceUrl })
          .success,
      ).toBe(false);
    }
  });

  it("allows only safe HTTPS URLs from exact or subdomain provider hosts", () => {
    for (const value of [
      "https://youtube.com/watch?v=example",
      "https://music.youtube.com/watch?v=example",
      "https://soundcloud.com/artist/track",
      "https://api-v2.soundcloud.com/tracks/1",
      "https://bandcamp.com/track/example",
      "https://artist.bandcamp.com/track/example",
      "https://deezer.com/track/1",
      "https://api.deezer.com/track/1",
      "https://dzcdn.net/images/cover.jpg",
      "https://e-cdns-proxy-3.dzcdn.net/images/cover.jpg",
    ]) {
      expect(parseAllowedDownloadSourceUrl(value)?.href).toBe(
        new URL(value).href,
      );
    }

    for (const value of FORBIDDEN_SOURCE_URLS) {
      expect(parseAllowedDownloadSourceUrl(value)).toBeNull();
    }

    expect(
      parseAllowedDownloadSourceUrl("https://youtube.com:443/watch?v=example")
        ?.port,
    ).toBe("");
  });

  it("parses only strict bounded completed job results", () => {
    expect(downloadJobResultSchema.parse(downloadJobResult)).toEqual(
      downloadJobResult,
    );
    expect(
      downloadJobResultSchema.safeParse({ ...downloadJobResult, extra: true })
        .success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        storageKey: `${JOB_ID}.wav`,
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        fileSize: DOWNLOAD_MAX_FILE_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({ ...downloadJobResult, fileSize: 1.5 })
        .success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        mimeType: "audio/wav",
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        storageKey: `${JOB_ID}.flac`,
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        storageKey: `${JOB_ID}.flac`,
        mimeType: "audio/flac",
      }).success,
    ).toBe(true);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        filename: "bad/name.mp3",
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        filename: "bad\\name.mp3",
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        filename: "bad\r\nname.mp3",
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        filename: "bad\0name.mp3",
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        filename: `x${"x".repeat(255)}`,
      }).success,
    ).toBe(false);
    expect(
      downloadJobResultSchema.safeParse({
        ...downloadJobResult,
        completedAt: "2026-07-26",
      }).success,
    ).toBe(false);
  });

  it("accepts only known job statuses", () => {
    expect(downloadJobStatusSchema.options).toEqual([
      "queued",
      "active",
      "completed",
      "failed",
    ]);
    expect(downloadJobStatusSchema.safeParse("delayed").success).toBe(false);
  });

  it("parses strict ranged file commands", () => {
    const command = {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      accountId: ACCOUNT_ID,
      jobId: JOB_ID,
      range: { start: 0, end: DOWNLOAD_MAX_FILE_BYTES - 1 },
    } as const;

    expect(downloadFileCommandSchema.parse(command)).toEqual(command);
    expect(
      downloadFileCommandSchema.parse({ ...command, range: { start: 0 } }),
    ).toEqual({
      ...command,
      range: { start: 0 },
    });
    expect(
      downloadFileCommandSchema.safeParse({
        ...command,
        requestId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      downloadFileCommandSchema.safeParse({
        ...command,
        jobId: JOB_ID.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      downloadFileCommandSchema.safeParse({ ...command, range: { start: -1 } })
        .success,
    ).toBe(false);
    expect(
      downloadFileCommandSchema.safeParse({
        ...command,
        range: { start: 0, end: DOWNLOAD_MAX_FILE_BYTES },
      }).success,
    ).toBe(false);
    expect(
      downloadFileCommandSchema.safeParse({
        ...command,
        range: { start: 2, end: 1 },
      }).success,
    ).toBe(false);
    expect(
      downloadFileCommandSchema.safeParse({
        ...command,
        range: { start: 0, extra: true },
      }).success,
    ).toBe(false);
    expect(
      downloadFileCommandSchema.safeParse({ ...command, extra: true }).success,
    ).toBe(false);
  });
});
