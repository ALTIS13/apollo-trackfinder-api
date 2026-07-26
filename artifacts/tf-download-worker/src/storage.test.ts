import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadStorage } from "./storage";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_JOB_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_JOB_ID = "33333333-3333-4333-8333-333333333333";
const FOURTH_JOB_ID = "44444444-4444-4444-8444-444444444444";
const COMPLETED_AT = "2026-07-26T00:00:00.000Z";

const metadata = {
  filename: "Artist - Title.mp3",
  mimeType: "audio/mpeg" as const,
  completedAt: COMPLETED_AT,
};

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tf-download-storage-"));
  roots.push(root);
  return root;
}

async function listNames(root: string): Promise<string[]> {
  return (await readdir(root)).sort();
}

async function createForeignSymlink(
  linkPath: string,
  outsideRoot: string,
): Promise<string> {
  const marker = path.join(outsideRoot, "marker");
  await writeFile(marker, "outside");
  await symlink(
    outsideRoot,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
  return marker;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("DownloadStorage", () => {
  it("creates an exclusive same-directory partial and commits an opaque UUID key", async () => {
    const root = await createRoot();
    const storage = await DownloadStorage.create({ root });

    const output = await storage.begin(JOB_ID, "mp3");
    expect(await listNames(root)).toEqual([`${JOB_ID}.mp3.part`]);
    await expect(storage.begin(JOB_ID, "mp3")).rejects.toThrow(
      "storage_unavailable",
    );

    expect(await output.write(Buffer.from("audio"))).toBe(true);
    expect(await listNames(root)).toEqual([`${JOB_ID}.mp3.part`]);

    const result = await output.commit(metadata);
    expect(result).toEqual({
      schemaVersion: 1,
      storageKey: `${JOB_ID}.mp3`,
      fileSize: 5,
      mimeType: "audio/mpeg",
      filename: "Artist - Title.mp3",
      completedAt: COMPLETED_AT,
    });
    expect(await listNames(root)).toEqual([`${JOB_ID}.mp3`]);
    expect(await readFile(path.join(root, result.storageKey), "utf8")).toBe(
      "audio",
    );
  });

  it("rejects noncanonical or escaping keys before touching the owned root", async () => {
    const root = await createRoot();
    const storage = await DownloadStorage.create({ root });

    for (const invalid of [
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "../11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111/escape",
      "not-a-uuid",
    ]) {
      await expect(storage.begin(invalid, "mp3")).rejects.toThrow(
        "storage_unavailable",
      );
    }
    await expect(
      storage.begin(JOB_ID, "../mp3" as "mp3"),
    ).rejects.toThrow("storage_unavailable");
    expect(await listNames(root)).toEqual([]);
  });

  it("refuses a symlink or non-regular file at an owned partial path", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const partName = `${JOB_ID}.mp3.part`;
    const marker = await createForeignSymlink(
      path.join(root, partName),
      outside,
    );

    const storage = await DownloadStorage.create({ root });
    await expect(storage.begin(JOB_ID, "mp3")).rejects.toThrow(
      "storage_unavailable",
    );
    expect((await lstat(path.join(root, partName))).isSymbolicLink()).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("outside");

    await rm(path.join(root, partName));
    await mkdir(path.join(root, partName));
    await expect(storage.begin(JOB_ID, "mp3")).rejects.toThrow(
      "storage_unavailable",
    );
    expect((await lstat(path.join(root, partName))).isDirectory()).toBe(true);
  });

  it("enforces the logical writer limit without allocating the production limit", async () => {
    const root = await createRoot();
    const storage = await DownloadStorage.create({
      root,
      maxFileBytes: 32,
    });

    const output = await storage.begin(JOB_ID, "mp3");
    await output.write(Buffer.alloc(33));
    await expect(output.commit(metadata)).rejects.toThrow("output_too_large");
    expect(await listNames(root)).toEqual([]);
  });

  it("removes only its tracked partial when aborted", async () => {
    const root = await createRoot();
    const foreign = path.join(root, "foreign.part");
    await writeFile(foreign, "keep");
    const storage = await DownloadStorage.create({ root });
    const output = await storage.begin(JOB_ID, "mp3");
    await output.write(Buffer.from("partial"));

    await output.abort();
    await output.abort();

    expect(await listNames(root)).toEqual(["foreign.part"]);
    expect(await readFile(foreign, "utf8")).toBe("keep");
  });

  it("startup removes only regular canonical owned partials", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const ownedPart = path.join(root, `${JOB_ID}.mp3.part`);
    const foreignPart = path.join(root, "foreign.mp3.part");
    const symlinkPart = path.join(root, `${SECOND_JOB_ID}.mp3.part`);
    const directoryPart = path.join(root, `${THIRD_JOB_ID}.flac.part`);

    await writeFile(ownedPart, "partial");
    await writeFile(foreignPart, "foreign");
    const marker = await createForeignSymlink(symlinkPart, outside);
    await mkdir(directoryPart);

    await DownloadStorage.create({ root });

    expect(await listNames(root)).toEqual([
      `${SECOND_JOB_ID}.mp3.part`,
      `${THIRD_JOB_ID}.flac.part`,
      "foreign.mp3.part",
    ]);
    expect((await lstat(symlinkPart)).isSymbolicLink()).toBe(true);
    expect((await lstat(directoryPart)).isDirectory()).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("outside");
  });

  it("sweeps expired files first and then the oldest files to satisfy quota", async () => {
    const root = await createRoot();
    const now = Date.UTC(2026, 6, 26, 12);
    const expiredKey = `${JOB_ID}.mp3`;
    const oldestKey = `${SECOND_JOB_ID}.mp3`;
    const newestKey = `${THIRD_JOB_ID}.mp3`;
    const foreign = path.join(root, "notes.txt");
    const outside = await createRoot();
    const symlinkKey = `${FOURTH_JOB_ID}.mp3`;

    await writeFile(path.join(root, expiredKey), Buffer.alloc(2));
    await writeFile(path.join(root, oldestKey), Buffer.alloc(4));
    await writeFile(path.join(root, newestKey), Buffer.alloc(4));
    await writeFile(foreign, "keep");
    const marker = await createForeignSymlink(
      path.join(root, symlinkKey),
      outside,
    );
    await utimes(path.join(root, expiredKey), new Date(now - 2_000), new Date(now - 2_000));
    await utimes(path.join(root, oldestKey), new Date(now - 900), new Date(now - 900));
    await utimes(path.join(root, newestKey), new Date(now - 800), new Date(now - 800));

    const storage = await DownloadStorage.create({
      root,
      now: () => now,
      ttlMs: 1_000,
      quotaBytes: 4,
    });
    const result = await storage.sweep();

    expect(result.removedStorageKeys).toEqual([expiredKey, oldestKey]);
    expect(result.bytesRemaining).toBe(4);
    expect(result.quotaSatisfied).toBe(true);
    expect(await listNames(root)).toEqual([
      newestKey,
      `${FOURTH_JOB_ID}.mp3`,
      "notes.txt",
    ]);
    expect(await readFile(foreign, "utf8")).toBe("keep");
    expect(await readFile(marker, "utf8")).toBe("outside");
  });

  it("evicts expired and then oldest owned finals while writing new output", async () => {
    const root = await createRoot();
    const now = Date.UTC(2026, 6, 26, 12);
    const expiredKey = `${SECOND_JOB_ID}.mp3`;
    const oldestKey = `${THIRD_JOB_ID}.mp3`;
    const newestKey = `${FOURTH_JOB_ID}.mp3`;

    await writeFile(path.join(root, expiredKey), Buffer.alloc(2));
    await writeFile(path.join(root, oldestKey), Buffer.alloc(2));
    await writeFile(path.join(root, newestKey), Buffer.alloc(2));
    await utimes(path.join(root, expiredKey), new Date(now - 2_000), new Date(now - 2_000));
    await utimes(path.join(root, oldestKey), new Date(now - 900), new Date(now - 900));
    await utimes(path.join(root, newestKey), new Date(now - 800), new Date(now - 800));

    const storage = await DownloadStorage.create({
      root,
      now: () => now,
      ttlMs: 1_000,
      quotaBytes: 4,
    });
    const output = await storage.begin(JOB_ID, "mp3");
    expect(await output.write(Buffer.alloc(2))).toBe(true);
    expect(await listNames(root)).toEqual([
      `${JOB_ID}.mp3.part`,
      newestKey,
    ]);

    const result = await output.commit(metadata);

    expect(result.storageKey).toBe(`${JOB_ID}.mp3`);
    expect(await listNames(root)).toEqual([
      `${JOB_ID}.mp3`,
      newestKey,
    ]);
  });

  it("rescans and evicts an owned final introduced before commit", async () => {
    const root = await createRoot();
    const now = Date.UTC(2026, 6, 26, 12);
    const storage = await DownloadStorage.create({
      root,
      now: () => now,
      ttlMs: 1_000,
      quotaBytes: 4,
    });
    const output = await storage.begin(JOB_ID, "mp3");
    expect(await output.write(Buffer.alloc(2))).toBe(true);

    const expiredKey = `${SECOND_JOB_ID}.mp3`;
    const expiredPath = path.join(root, expiredKey);
    await writeFile(expiredPath, Buffer.alloc(4));
    await utimes(
      expiredPath,
      new Date(now - 2_000),
      new Date(now - 2_000),
    );

    const result = await output.commit(metadata);

    expect(result.storageKey).toBe(`${JOB_ID}.mp3`);
    expect(await listNames(root)).toEqual([`${JOB_ID}.mp3`]);
  });

  it("rejects an output that cannot fit at commit and removes its partial", async () => {
    const root = await createRoot();
    const storage = await DownloadStorage.create({
      root,
      maxFileBytes: 4,
      quotaBytes: 1,
    });
    const output = await storage.begin(JOB_ID, "mp3");
    expect(await output.write(Buffer.alloc(2))).toBe(false);

    await expect(output.commit(metadata)).rejects.toThrow(
      "storage_quota_exceeded",
    );
    expect(await listNames(root)).toEqual([]);
  });

  it("does not allow two concurrent commits to overrun the quota", async () => {
    const root = await createRoot();
    const storage = await DownloadStorage.create({
      root,
      maxFileBytes: 4,
      quotaBytes: 3,
    });
    const first = await storage.begin(JOB_ID, "mp3");
    const second = await storage.begin(SECOND_JOB_ID, "mp3");
    expect(await first.write(Buffer.alloc(2))).toBe(true);
    expect(await second.write(Buffer.alloc(2))).toBe(false);

    const outcomes = await Promise.allSettled([
      first.commit(metadata),
      second.commit(metadata),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(await listNames(root)).toHaveLength(1);
    expect((await listNames(root))[0]).toMatch(/\.mp3$/);
  });

  it("does not mutate entries when bounded enumeration is truncated", async () => {
    const root = await createRoot();
    const now = Date.UTC(2026, 6, 26, 12);
    for (const jobId of [JOB_ID, SECOND_JOB_ID, THIRD_JOB_ID]) {
      const file = path.join(root, `${jobId}.mp3`);
      await writeFile(file, Buffer.alloc(2));
      await utimes(file, new Date(now - 2_000), new Date(now - 2_000));
    }

    const storage = await DownloadStorage.create({
      root,
      now: () => now,
      ttlMs: 1_000,
      quotaBytes: 1,
      maxSweepEntries: 2,
    });
    const result = await storage.sweep();

    expect(result.scannedEntries).toBe(2);
    expect(result.removedStorageKeys).toEqual([]);
    expect(result.quotaSatisfied).toBe(false);
    expect(await listNames(root)).toEqual([
      `${JOB_ID}.mp3`,
      `${SECOND_JOB_ID}.mp3`,
      `${THIRD_JOB_ID}.mp3`,
    ]);
  });
});
