import { act, renderHook } from "@testing-library/react";
import type {
  DownloadJobStatus,
  TrackResult,
} from "@workspace/api-client-react";
import {
  cancelDownloadJob,
  getDownloadJobStatus,
  queueTrackDownloads,
} from "@workspace/api-client-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportTfAuthError, tfRequestInit } from "@/lib/tf-session-client";
import { useTrackDownload } from "./use-track-download";

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    queueTrackDownloads: vi.fn(),
    getDownloadJobStatus: vi.fn(),
    cancelDownloadJob: vi.fn(),
  };
});

vi.mock("@/lib/tf-session-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tf-session-client")>();
  return {
    ...actual,
    reportTfAuthError: vi.fn(),
    tfRequestInit: vi.fn((init: RequestInit = {}) => ({
      ...init,
      credentials: "include",
    })),
  };
});

const track: TrackResult = {
  id: "track-1",
  title: "Test Track",
  artist: "Test Artist",
  thumbnailUrl: null,
  duration: 180,
  source: "youtube",
  type: "original",
  quality: [],
  score: 1,
};

const waiting: DownloadJobStatus = {
  status: "waiting",
  progress: 12,
  position: 1,
};
const active: DownloadJobStatus = { status: "active", progress: 64 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(queueTrackDownloads).mockReset();
  vi.mocked(getDownloadJobStatus).mockReset();
  vi.mocked(cancelDownloadJob).mockReset();
  vi.mocked(reportTfAuthError).mockReset();
  vi.mocked(tfRequestInit).mockClear();
  vi.stubGlobal("location", { assign: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTrackDownload", () => {
  it("queues exactly one track and guards repeated starts while waiting", async () => {
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    vi.mocked(getDownloadJobStatus).mockImplementation(
      () => new Promise(() => {}),
    );
    const { result } = renderHook(() => useTrackDownload());

    await act(async () => {
      await Promise.all([
        result.current.start(track),
        result.current.start(track),
      ]);
    });

    expect(queueTrackDownloads).toHaveBeenCalledTimes(1);
    expect(queueTrackDownloads).toHaveBeenCalledWith(
      {
        tracks: [
          {
            trackId: track.id,
            artist: track.artist,
            title: track.title,
            quality: "320",
          },
        ],
      },
      expect.objectContaining({ credentials: "include", method: "POST" }),
    );
    expect(result.current.state).toBe("waiting");
  });

  it("renders a bounded failed state for a per-track queue rejection", async () => {
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [
        {
          trackId: track.id,
          error: "download_queue_unavailable",
        },
      ],
    });
    const { result } = renderHook(() => useTrackDownload());

    await act(async () => {
      await result.current.start(track);
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.progress).toBe(0);
    expect(reportTfAuthError).not.toHaveBeenCalled();
    expect(getDownloadJobStatus).not.toHaveBeenCalled();
    expect(cancelDownloadJob).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("keeps one poll in flight and uses bounded backoff only for waiting and active jobs", async () => {
    const firstPoll = deferred<DownloadJobStatus>();
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    vi.mocked(getDownloadJobStatus)
      .mockReturnValueOnce(firstPoll.promise)
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ status: "failed", progress: 64 });
    const { result } = renderHook(() => useTrackDownload());

    await act(async () => {
      await result.current.start(track);
    });
    expect(getDownloadJobStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getDownloadJobStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstPoll.resolve(waiting);
    });
    await flushMicrotasks();
    expect(result.current.progress).toBe(12);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(getDownloadJobStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getDownloadJobStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(getDownloadJobStatus).toHaveBeenCalledTimes(3);
    await flushMicrotasks();
    expect(result.current.state).toBe("failed");
  });

  it("clamps progress and initiates exactly one authenticated file navigation after completion", async () => {
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    vi.mocked(getDownloadJobStatus).mockResolvedValue({
      status: "completed",
      progress: 175,
    });
    const { result } = renderHook(() => useTrackDownload());

    await act(async () => {
      await result.current.start(track);
    });
    await flushMicrotasks();
    expect(result.current.state).toBe("completed");
    expect(result.current.progress).toBe(100);
    expect(window.location.assign).toHaveBeenCalledTimes(1);
    expect(window.location.assign).toHaveBeenCalledWith(
      "/api/tracks/download/file/job-1",
    );
    expect(tfRequestInit).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(window.location.assign).toHaveBeenCalledTimes(1);
  });

  it("cancels the job, aborts polling, and keeps its canceled state", async () => {
    const poll = deferred<DownloadJobStatus>();
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    vi.mocked(getDownloadJobStatus).mockReturnValue(poll.promise);
    vi.mocked(cancelDownloadJob).mockResolvedValue({
      jobId: "job-1",
      status: "canceled",
    });
    const { result } = renderHook(() => useTrackDownload());

    await act(async () => {
      await result.current.start(track);
    });
    const statusRequest = vi.mocked(getDownloadJobStatus).mock.calls[0][1];
    await act(async () => {
      await result.current.cancel();
    });

    expect(cancelDownloadJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        credentials: "include",
        method: "DELETE",
      }),
    );
    expect((statusRequest?.signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.state).toBe("canceled");

    await act(async () => {
      poll.resolve({ status: "completed", progress: 100 });
      await Promise.resolve();
    });
    expect(result.current.state).toBe("canceled");
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("compensates a canceled pending queue acknowledgement exactly once", async () => {
    const queued = deferred<{
      results: Array<{ trackId: string; jobId: string; position: number }>;
    }>();
    vi.mocked(queueTrackDownloads).mockReturnValue(queued.promise);
    vi.mocked(cancelDownloadJob).mockResolvedValue({
      jobId: "job-late",
      status: "canceled",
    });
    const { result } = renderHook(() => useTrackDownload());

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.start(track);
      await Promise.resolve();
    });
    const queueRequest = vi.mocked(queueTrackDownloads).mock.calls[0][1];

    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.state).toBe("canceled");
    expect((queueRequest?.signal as AbortSignal).aborted).toBe(false);

    await act(async () => {
      queued.resolve({
        results: [{ trackId: track.id, jobId: "job-late", position: 1 }],
      });
      await startPromise;
    });

    expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
    expect(cancelDownloadJob).toHaveBeenCalledWith(
      "job-late",
      expect.objectContaining({ credentials: "include", method: "DELETE" }),
    );
    expect(getDownloadJobStatus).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(result.current.state).toBe("canceled");
  });

  it("lets a restarted generation proceed while compensating only the old late acknowledgement", async () => {
    const oldQueue = deferred<{
      results: Array<{ trackId: string; jobId: string; position: number }>;
    }>();
    vi.mocked(queueTrackDownloads)
      .mockReturnValueOnce(oldQueue.promise)
      .mockResolvedValueOnce({
        results: [{ trackId: track.id, jobId: "job-current", position: 1 }],
      });
    vi.mocked(getDownloadJobStatus).mockResolvedValue({
      status: "completed",
      progress: 100,
    });
    vi.mocked(cancelDownloadJob).mockResolvedValue({
      jobId: "job-old",
      status: "canceled",
    });
    const { result } = renderHook(() => useTrackDownload());

    let oldStart!: Promise<void>;
    await act(async () => {
      oldStart = result.current.start(track);
      await Promise.resolve();
      await result.current.cancel();
      await result.current.start(track);
    });
    await flushMicrotasks();

    expect(getDownloadJobStatus).toHaveBeenCalledTimes(1);
    expect(getDownloadJobStatus).toHaveBeenCalledWith(
      "job-current",
      expect.any(Object),
    );
    expect(result.current.state).toBe("completed");
    expect(window.location.assign).toHaveBeenCalledWith(
      "/api/tracks/download/file/job-current",
    );

    await act(async () => {
      oldQueue.resolve({
        results: [{ trackId: track.id, jobId: "job-old", position: 1 }],
      });
      await oldStart;
    });

    expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
    expect(cancelDownloadJob).toHaveBeenCalledWith(
      "job-old",
      expect.any(Object),
    );
    expect(getDownloadJobStatus).toHaveBeenCalledTimes(1);
    expect(window.location.assign).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("completed");
  });

  it("does not duplicate compensation after repeated pre-ack cancel calls", async () => {
    const queued = deferred<{
      results: Array<{ trackId: string; jobId: string; position: number }>;
    }>();
    vi.mocked(queueTrackDownloads).mockReturnValue(queued.promise);
    vi.mocked(cancelDownloadJob).mockResolvedValue({
      jobId: "job-late",
      status: "canceled",
    });
    const { result } = renderHook(() => useTrackDownload());

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.start(track);
      await Promise.resolve();
      await result.current.cancel();
      await result.current.cancel();
    });
    await act(async () => {
      queued.resolve({
        results: [{ trackId: track.id, jobId: "job-late", position: 1 }],
      });
      await startPromise;
    });

    expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
    expect(getDownloadJobStatus).not.toHaveBeenCalled();
    expect(result.current.state).toBe("canceled");
  });

  it.each([401, 403, 409])(
    "forwards queue error %s through reportTfAuthError",
    async (status) => {
      const error = { status, data: { error: "bounded_error" } };
      vi.mocked(queueTrackDownloads).mockRejectedValue(error);
      const { result } = renderHook(() => useTrackDownload());

      await act(async () => {
        await result.current.start(track);
      });

      expect(reportTfAuthError).toHaveBeenCalledWith(error);
      expect(result.current.state).toBe("failed");
    },
  );

  it("aborts in-flight work on unmount and cannot navigate from a stale completion", async () => {
    const poll = deferred<DownloadJobStatus>();
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    vi.mocked(getDownloadJobStatus).mockReturnValue(poll.promise);
    const { result, unmount } = renderHook(() => useTrackDownload());

    await act(async () => {
      await result.current.start(track);
    });
    const request = vi.mocked(getDownloadJobStatus).mock.calls[0][1];
    unmount();

    expect((request?.signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      poll.resolve({ status: "completed", progress: 100 });
      await Promise.resolve();
    });
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("aborts a pending queue request on unmount without compensating a mocked late acknowledgement", async () => {
    const queued = deferred<{
      results: Array<{ trackId: string; jobId: string; position: number }>;
    }>();
    vi.mocked(queueTrackDownloads).mockReturnValue(queued.promise);
    const { result, unmount } = renderHook(() => useTrackDownload());

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.start(track);
      await Promise.resolve();
    });
    const queueRequest = vi.mocked(queueTrackDownloads).mock.calls[0][1];
    unmount();

    expect((queueRequest?.signal as AbortSignal).aborted).toBe(true);
    await act(async () => {
      queued.resolve({
        results: [{ trackId: track.id, jobId: "job-late", position: 1 }],
      });
      await startPromise;
    });
    expect(cancelDownloadJob).not.toHaveBeenCalled();
    expect(getDownloadJobStatus).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});
