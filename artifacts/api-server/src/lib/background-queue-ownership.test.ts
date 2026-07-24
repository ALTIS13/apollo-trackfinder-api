import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("./ytdlp.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ytdlp.js")>();
  return {
    ...original,
    spawnAudioDownload: vi.fn(() => {
      const process = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
      };
      process.stdout = new PassThrough();
      process.stderr = new PassThrough();
      setImmediate(() => {
        process.stdout.end(Buffer.alloc(2_048, 1));
        setTimeout(() => process.emit("close", 0), 20);
      });
      return process;
    }),
  };
});

process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
const downloadDirectory = await mkdtemp(
  path.join(tmpdir(), "apollo-tf-owner-test-"),
);
process.env["DOWNLOAD_DIR"] = downloadDirectory;

const queue = await import("./background-queue.js");
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await access(filePath);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("download did not complete");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function enqueueWithOwner(
  trackId: string,
  owner: unknown,
): Promise<{ readonly jobId: string; readonly filePath: string }> {
  const filePath = path.join(downloadDirectory, `${trackId}.mp3`);
  const result = await queue.enqueueDownload({
    trackId,
    artist: "Artist",
    title: "Title",
    quality: "128",
    sourceUrl: "https://www.youtube.com/watch?v=owner-test",
    sessionId: owner,
  } as Parameters<typeof queue.enqueueDownload>[0]);
  await waitForFile(filePath);
  return { jobId: result.jobId, filePath };
}

afterAll(async () => {
  await queue.shutdownBackgroundQueues();
  await rm(downloadDirectory, { recursive: true, force: true });
  delete process.env["DOWNLOAD_DIR"];
});

describe("download queue helper ownership", () => {
  it("denies status, file, and list access for missing or malformed legacy owners", async () => {
    const emptyOwner = await enqueueWithOwner("ownerless-empty", "");
    const missingOwner = await enqueueWithOwner("ownerless-missing", undefined);
    const malformedOwner = await enqueueWithOwner(
      "ownerless-malformed",
      "legacy-owner",
    );

    for (const job of [emptyOwner, missingOwner, malformedOwner]) {
      await expect(
        queue.getDownloadJobStatus(job.jobId, ACCOUNT_ID),
      ).resolves.toEqual({ status: "unknown", progress: 0 });
      await expect(
        queue.getDownloadFilePath(job.jobId, ACCOUNT_ID),
      ).resolves.toBeNull();
    }
    await expect(queue.listSessionDownloadJobs("")).resolves.toEqual([]);
    await expect(
      queue.listSessionDownloadJobs("legacy-owner"),
    ).resolves.toEqual([]);
  });

  it("still allows an exact nonempty owner match", async () => {
    const owned = await enqueueWithOwner("account-owned", ACCOUNT_ID);

    await expect(
      queue.getDownloadJobStatus(owned.jobId, ACCOUNT_ID),
    ).resolves.toMatchObject({ status: "completed", progress: 100 });
    await expect(
      queue.getDownloadFilePath(owned.jobId, ACCOUNT_ID),
    ).resolves.toBe(owned.filePath);
    await expect(queue.listSessionDownloadJobs(ACCOUNT_ID)).resolves.toEqual([
      expect.objectContaining({
        jobId: owned.jobId,
        status: "completed",
      }),
    ]);
  });
});
