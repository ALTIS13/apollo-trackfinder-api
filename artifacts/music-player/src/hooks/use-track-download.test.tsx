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

  it("ignores a stale queue generation after rapid start, cancel, and restart", async () => {
    const firstQueue = deferred<{
      results: Array<{ trackId: string; jobId: string; position: number }>;
    }>();
    vi.mocked(queueTrackDownloads)
      .mockReturnValueOnce(firstQueue.promise)
      .mockResolvedValueOnce({
        results: [{ trackId: track.id, jobId: "job-2", position: 1 }],
      });
    vi.mocked(getDownloadJobStatus).mockResolvedValue({
      status: "waiting",
      progress: 3,
      position: 1,
    });
    const { result } = renderHook(() => useTrackDownload());

    let firstStart!: Promise<void>;
    await act(async () => {
      firstStart = result.current.start(track);
      await Promise.resolve();
      await result.current.cancel();
      await result.current.start(track);
    });
    await act(async () => {
      firstQueue.resolve({
        results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
      });
      await firstStart;
    });

    expect(getDownloadJobStatus).toHaveBeenCalledWith(
      "job-2",
      expect.any(Object),
    );
    expect(getDownloadJobStatus).not.toHaveBeenCalledWith(
      "job-1",
      expect.any(Object),
    );
    expect(result.current.state).toBe("waiting");
    expect(result.current.progress).toBe(3);
  });
});
