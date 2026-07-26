import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseTfDownloadWorkerConfig } from "./config.js";

const commandSecret = "c".repeat(32);
const heartbeatSecret = "h".repeat(32);
const queuePassword = `p@ss${"q".repeat(28)}`;
const encodedQueuePassword = encodeURIComponent(queuePassword);
const secureQueueUrl = `rediss://worker:${encodedQueuePassword}@queue.apollot.ru:6380/3`;
const secureQueueConnection = {
  protocol: "rediss:",
  host: "queue.apollot.ru",
  port: 6380,
  db: 3,
  username: "worker",
  password: queuePassword,
} as const;
const storageRoot = path.resolve("C:/apollo-tf/downloads");

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: "8080",
    TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: "/run/secrets/download-queue-url",
    TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/download-command",
    TF_DOWNLOAD_HEARTBEAT_SECRET_FILE: "/run/secrets/download-heartbeat",
    TF_DOWNLOAD_HEARTBEAT_API_ORIGIN: "https://api.apollot.ru",
    TF_DOWNLOAD_STORAGE_ROOT: storageRoot,
    APOLLO_API_VERSION: "2026.7.26",
    APOLLO_DEPLOYED_AT: "2026-07-26T12:00:00.000Z",
    ...overrides,
  };
}

function files(
  overrides: Readonly<Record<string, string | Buffer>> = {},
): Readonly<Record<string, string | Buffer>> {
  return {
    "/run/secrets/download-queue-url": secureQueueUrl,
    "/run/secrets/download-command": commandSecret,
    "/run/secrets/download-heartbeat": heartbeatSecret,
    ...overrides,
  };
}

function reader(values = files()) {
  return vi.fn(
    async (filePath: string, _maximumBytes: number): Promise<Buffer> => {
      const value = values[filePath];
      if (value === undefined) throw new Error("unreadable");
      return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    },
  );
}

describe("TF download worker runtime configuration", () => {
  it("loads each bounded file once and returns strict runtime limits", async () => {
    const readFile = reader();

    await expect(
      parseTfDownloadWorkerConfig(environment(), readFile),
    ).resolves.toEqual({
      port: 8080,
      queueRedisConnection: secureQueueConnection,
      internalAuthSecret: commandSecret,
      heartbeatSecret,
      heartbeatApiOrigin: "https://api.apollot.ru",
      storageRoot,
      downloaderExecutable: "/usr/local/bin/yt-dlp",
      version: "2026.7.26",
      deployedAt: "2026-07-26T12:00:00.000Z",
      maxFileBytes: 1_073_741_824,
      storageQuotaBytes: 21_474_836_480,
      fileTtlMs: 86_400_000,
      sweepIntervalMs: 300_000,
      shutdownGraceMs: 30_000,
      queueProbeTimeoutMs: 3_000,
    });
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(readFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      "/run/secrets/download-queue-url",
      "/run/secrets/download-command",
      "/run/secrets/download-heartbeat",
    ]);
    expect(readFile.mock.calls.map(([, maximumBytes]) => maximumBytes)).toEqual(
      [2_048, 1_024, 1_024],
    );
  });

  it("rejects an oversized sparse file without loading it into memory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "apollo-tf-config-"));
    const queueFile = path.join(directory, "queue-url");
    const file = await open(queueFile, "w");
    try {
      await file.truncate(2_147_483_648);
    } finally {
      await file.close();
    }

    try {
      await expect(
        parseTfDownloadWorkerConfig(
          environment({
            TF_DOWNLOAD_QUEUE_REDIS_URL_FILE: queueFile,
          }),
        ),
      ).rejects.toThrow("invalid runtime configuration");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects every inline secret or queue URL by presence", async () => {
    for (const name of [
      "TF_DOWNLOAD_QUEUE_REDIS_URL",
      "TF_DOWNLOAD_INTERNAL_AUTH_SECRET",
      "TF_DOWNLOAD_HEARTBEAT_SECRET",
    ]) {
      for (const value of ["", "inline-secret"]) {
        await expect(
          parseTfDownloadWorkerConfig(environment({ [name]: value }), reader()),
        ).rejects.toThrow("invalid runtime configuration");
      }
    }
  });

  it("requires readable bounded files and distinct 32..512 byte secrets", async () => {
    for (const value of [
      "",
      "x".repeat(31),
      "x".repeat(513),
      "🙂".repeat(129),
    ]) {
      await expect(
        parseTfDownloadWorkerConfig(
          environment(),
          reader(files({ "/run/secrets/download-command": value })),
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
    await expect(
      parseTfDownloadWorkerConfig(
        environment(),
        reader(
          files({
            "/run/secrets/download-heartbeat": commandSecret,
          }),
        ),
      ),
    ).rejects.toThrow("invalid runtime configuration");
    await expect(
      parseTfDownloadWorkerConfig(
        environment(),
        reader({
          ...files(),
          "/run/secrets/download-queue-url": "x".repeat(2_049),
        }),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it("uses UTF-8 byte boundaries for heartbeat secrets", async () => {
    for (const value of ["é".repeat(16), "é".repeat(256)]) {
      await expect(
        parseTfDownloadWorkerConfig(
          environment(),
          reader(
            files({
              "/run/secrets/download-heartbeat": value,
            }),
          ),
        ),
      ).resolves.toMatchObject({ heartbeatSecret: value });
    }
    for (const value of ["é".repeat(15), "é".repeat(257)]) {
      await expect(
        parseTfDownloadWorkerConfig(
          environment(),
          reader(
            files({
              "/run/secrets/download-heartbeat": value,
            }),
          ),
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });

  it("rejects malformed UTF-8 in every file-backed value", async () => {
    for (const filePath of [
      "/run/secrets/download-queue-url",
      "/run/secrets/download-command",
      "/run/secrets/download-heartbeat",
    ]) {
      await expect(
        parseTfDownloadWorkerConfig(
          environment(),
          reader(
            files({
              [filePath]:
                filePath === "/run/secrets/download-queue-url"
                  ? Buffer.concat([
                      Buffer.from(`rediss://user:${"p".repeat(30)}`, "utf8"),
                      Buffer.from([0xc3, 0x28]),
                      Buffer.from("@queue.apollot.ru/0", "utf8"),
                    ])
                  : Buffer.concat([
                      Buffer.from("x".repeat(32), "utf8"),
                      Buffer.from([0xc3, 0x28]),
                    ]),
            }),
          ),
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });

  it("requires a 32..512 UTF-8 byte Redis password for redis and rediss", async () => {
    for (const password of [
      "p".repeat(32),
      "p".repeat(512),
      "é".repeat(16),
      "é".repeat(256),
    ]) {
      const encoded = encodeURIComponent(password);
      for (const [queueUrl, insecure] of [
        [`rediss://:${encoded}@queue.apollot.ru:6380/3`, false],
        [`redis://default:${encoded}@tf-download-redis:6379/0`, true],
      ] as const) {
        await expect(
          parseTfDownloadWorkerConfig(
            environment(
              insecure
                ? { TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true" }
                : {},
            ),
            reader(
              files({
                "/run/secrets/download-queue-url": queueUrl,
              }),
            ),
          ),
        ).resolves.toMatchObject({
          queueRedisConnection: { password },
        });
      }
    }

    for (const password of [
      "p",
      "p".repeat(31),
      "p".repeat(513),
      `${"é".repeat(256)}p`,
    ]) {
      const encoded = encodeURIComponent(password);
      for (const queueUrl of [
        `rediss://worker:${encoded}@queue.apollot.ru:6380/3`,
        `redis://default:${encoded}@tf-download-redis:6379/0`,
      ]) {
        await expect(
          parseTfDownloadWorkerConfig(
            environment({
              TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
            }),
            reader(
              files({
                "/run/secrets/download-queue-url": queueUrl,
              }),
            ),
          ),
        ).rejects.toThrow("invalid runtime configuration");
      }
    }

    for (const queueUrl of [
      "rediss://queue.apollot.ru:6380/3",
      `rediss://${"u".repeat(513)}:${encodedQueuePassword}@queue.apollot.ru:6380/3`,
      `rediss://user%0Aname:${encodedQueuePassword}@queue.apollot.ru:6380/3`,
      `rediss://worker:password%0A${"p".repeat(23)}@queue.apollot.ru:6380/3`,
    ]) {
      await expect(
        parseTfDownloadWorkerConfig(
          environment(),
          reader(
            files({
              "/run/secrets/download-queue-url": queueUrl,
            }),
          ),
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });

  it("allows private same-node redis/http only with exact explicit flags", async () => {
    const authenticatedQueueUrl = `redis://default:${encodedQueuePassword}@tf-download-redis:6379/0`;
    await expect(
      parseTfDownloadWorkerConfig(
        environment({
          TF_DOWNLOAD_HEARTBEAT_API_ORIGIN: "http://api-server:8080",
        }),
        reader(
          files({
            "/run/secrets/download-queue-url": authenticatedQueueUrl,
          }),
        ),
      ),
    ).rejects.toThrow("invalid runtime configuration");

    await expect(
      parseTfDownloadWorkerConfig(
        environment({
          TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
          TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
          TF_DOWNLOAD_HEARTBEAT_API_ORIGIN: "http://api-server:8080",
        }),
        reader(
          files({
            "/run/secrets/download-queue-url": authenticatedQueueUrl,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      queueRedisConnection: {
        protocol: "redis:",
        host: "tf-download-redis",
        port: 6379,
        db: 0,
        username: "default",
        password: queuePassword,
      },
      heartbeatApiOrigin: "http://api-server:8080",
    });

    for (const [name, value] of [
      ["TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS", "TRUE"],
      ["TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP", "1"],
      ["TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS", "false"],
      ["TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP", ""],
    ]) {
      await expect(
        parseTfDownloadWorkerConfig(environment({ [name]: value }), reader()),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });

  it("gates mixed-case redis schemes through the normalized protocol", async () => {
    for (const scheme of ["ReDiS", "REDIS"]) {
      const queueUrl = `${scheme}://default:${encodedQueuePassword}@tf-download-redis:6379/0`;
      await expect(
        parseTfDownloadWorkerConfig(
          environment(),
          reader(
            files({
              "/run/secrets/download-queue-url": queueUrl,
            }),
          ),
        ),
      ).rejects.toThrow("invalid runtime configuration");

      await expect(
        parseTfDownloadWorkerConfig(
          environment({
            TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
          }),
          reader(
            files({
              "/run/secrets/download-queue-url": queueUrl,
            }),
          ),
        ),
      ).resolves.toMatchObject({
        queueRedisConnection: {
          protocol: "redis:",
          host: "tf-download-redis",
          port: 6379,
          db: 0,
          username: "default",
          password: queuePassword,
        },
      });
    }
  });

  it("rejects unsafe origins, queue URLs, and non-normalized paths", async () => {
    for (const origin of [
      "https://api.apollot.ru/",
      "https://api.apollot.ru/path",
      "https://user:pass@api.apollot.ru",
      "http://192.168.1.20:8080",
    ]) {
      await expect(
        parseTfDownloadWorkerConfig(
          environment({
            TF_DOWNLOAD_HEARTBEAT_API_ORIGIN: origin,
            TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
          }),
          reader(),
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
    for (const queueUrl of [
      "rediss://queue.apollot.ru/03",
      "rediss://queue.apollot.ru/16",
      "rediss://queue.apollot.ru/0?secret=value",
      `redis://default:${encodedQueuePassword}@public.apollot.ru:6379/0`,
      `redis://default:${encodedQueuePassword}@10.0.0.2:6379/0`,
      "redis://tf-download-redis:6379/0",
      "redis://default:@tf-download-redis:6379/0",
      `redis://default:${encodedQueuePassword}@tf-download-redis:6379/1`,
      `redis://default:${encodedQueuePassword}@tf-download-redis:6380/0`,
      `redis://default:${encodedQueuePassword}@api-server:6379/0`,
      "redis://user%ZZ:password@tf-download-redis:6379/0",
      "redis://default:password%E0%A4%A@tf-download-redis:6379/0",
      "rediss://user%ZZ:password@queue.apollot.ru/0",
      "rediss://user:password%E0%A4%A@queue.apollot.ru/0",
    ]) {
      await expect(
        parseTfDownloadWorkerConfig(
          environment({
            TF_DOWNLOAD_QUEUE_ALLOW_INSECURE_REDIS: "true",
          }),
          reader(
            files({
              "/run/secrets/download-queue-url": queueUrl,
            }),
          ),
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
    await expect(
      parseTfDownloadWorkerConfig(
        environment(),
        reader(
          files({
            "/run/secrets/download-queue-url": `rediss://user%20name:${encodedQueuePassword}@queue.apollot.ru:6380/3`,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      queueRedisConnection: {
        protocol: "rediss:",
        host: "queue.apollot.ru",
        port: 6380,
        db: 3,
        username: "user name",
        password: queuePassword,
      },
    });
    await expect(
      parseTfDownloadWorkerConfig(
        environment({
          TF_DOWNLOAD_STORAGE_ROOT: `${storageRoot}${path.sep}..${path.sep}downloads`,
        }),
        reader(),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it("rejects every noncanonical raw Redis database path", async () => {
    for (const databasePath of [
      "/15/../0",
      "/./0",
      "/15/%2e%2e/0",
      "/15/%2E%2E/0",
      "/15/%2e./0",
      "/15/.%2e/0",
      "/15/%252e%252e/0",
      "/15%2f..%2f0",
      "/15%2F..%2F0",
      "/15%5c..%5c0",
      "/15%252f..%252f0",
      "/15%255c..%255c0",
      "/0/0",
      "/0/",
      "//0",
      "/00",
      "/01",
      "/+0",
      "/-0",
      "/%30",
      "/",
      "",
    ]) {
      await expect(
        parseTfDownloadWorkerConfig(
          environment(),
          reader(
            files({
              "/run/secrets/download-queue-url": `rediss://worker:${encodedQueuePassword}@queue.apollot.ru:6380${databasePath}`,
            }),
          ),
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });

  it("accepts only documented integer ranges and sanitized metadata", async () => {
    const invalid = [
      ["PORT", "0"],
      ["PORT", "65536"],
      ["TF_DOWNLOAD_MAX_FILE_BYTES", "1073741825"],
      ["TF_DOWNLOAD_STORAGE_QUOTA_BYTES", "1073741823"],
      ["TF_DOWNLOAD_FILE_TTL_MS", "59999"],
      ["TF_DOWNLOAD_SWEEP_INTERVAL_MS", "999"],
      ["TF_DOWNLOAD_SHUTDOWN_GRACE_MS", "999"],
      ["TF_DOWNLOAD_QUEUE_PROBE_TIMEOUT_MS", "99"],
      ["APOLLO_API_VERSION", "v".repeat(129)],
      ["APOLLO_DEPLOYED_AT", "2026-07-26"],
      ["APOLLO_DEPLOYED_AT", "2026-02-29T00:00:00.000Z"],
      ["APOLLO_DEPLOYED_AT", "2026-02-30T00:00:00.000Z"],
      ["APOLLO_DEPLOYED_AT", "2026-04-31T00:00:00.000Z"],
    ] as const;
    for (const [name, value] of invalid) {
      await expect(
        parseTfDownloadWorkerConfig(environment({ [name]: value }), reader()),
      ).rejects.toThrow("invalid runtime configuration");
    }

    await expect(
      parseTfDownloadWorkerConfig(
        environment({
          TF_DOWNLOAD_MAX_FILE_BYTES: "536870912",
          TF_DOWNLOAD_STORAGE_QUOTA_BYTES: "4294967296",
          TF_DOWNLOAD_FILE_TTL_MS: "3600000",
          TF_DOWNLOAD_SWEEP_INTERVAL_MS: "60000",
          TF_DOWNLOAD_SHUTDOWN_GRACE_MS: "15000",
          TF_DOWNLOAD_QUEUE_PROBE_TIMEOUT_MS: "1000",
        }),
        reader(),
      ),
    ).resolves.toMatchObject({
      maxFileBytes: 536_870_912,
      storageQuotaBytes: 4_294_967_296,
      fileTtlMs: 3_600_000,
      sweepIntervalMs: 60_000,
      shutdownGraceMs: 15_000,
      queueProbeTimeoutMs: 1_000,
    });
  });

  it("uses one generic error that does not leak file values", async () => {
    const canary = "DO_NOT_LEAK_THIS_SECRET";
    let caught: unknown;
    try {
      await parseTfDownloadWorkerConfig(
        environment(),
        reader(
          files({
            "/run/secrets/download-command": canary,
          }),
        ),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toBe("Error: invalid runtime configuration");
    expect(String(caught)).not.toContain(canary);
  });
});
