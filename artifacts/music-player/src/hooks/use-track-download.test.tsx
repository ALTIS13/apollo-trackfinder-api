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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
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

  it("polls the exact job from a waiting DELETE response until canceled without another DELETE", async () => {
    const cancellationPoll = deferred<DownloadJobStatus>();
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    vi.mocked(getDownloadJobStatus)
      .mockResolvedValueOnce(active)
      .mockReturnValueOnce(cancellationPoll.promise);
    vi.mocked(cancelDownloadJob)
      .mockResolvedValueOnce({ jobId: "job-1", status: "waiting" })
      .mockResolvedValueOnce({ jobId: "job-1", status: "canceled" });
    const { result } = renderHook(() => useTrackDownload());

    await act(async () => {
      await result.current.start(track);
    });
    await flushMicrotasks();

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state).toBe("waiting");
    expect(result.current.progress).toBe(64);
    expect(getDownloadJobStatus).toHaveBeenCalledTimes(2);
    expect(getDownloadJobStatus).toHaveBeenLastCalledWith(
      "job-1",
      expect.objectContaining({ credentials: "include", method: "GET" }),
    );

    await act(async () => {
      await result.current.cancel();
      await result.current.cancel();
    });
    expect(cancelDownloadJob).toHaveBeenCalledTimes(1);

    await act(async () => {
      cancellationPoll.resolve({ status: "canceled", progress: 73 });
    });
    await flushMicrotasks();

    expect(result.current.state).toBe("canceled");
    expect(result.current.progress).toBe(73);
    expect(vi.getTimerCount()).toBe(0);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("polls an active DELETE response to completed without navigating to the file", async () => {
    const cancellationPoll = deferred<DownloadJobStatus>();
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    vi.mocked(getDownloadJobStatus)
      .mockResolvedValueOnce(active)
      .mockReturnValueOnce(cancellationPoll.promise);
    vi.mocked(cancelDownloadJob).mockResolvedValue({
      jobId: "job-1",
      status: "active",
    });
    const { result } = renderHook(() => useTrackDownload());

    await act(async () => {
      await result.current.start(track);
    });
    await flushMicrotasks();

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state).toBe("active");
    expect(result.current.progress).toBe(64);
    expect(getDownloadJobStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      cancellationPoll.resolve({ status: "completed", progress: 100 });
    });
    await flushMicrotasks();

    expect(result.current.state).toBe("completed");
    expect(result.current.progress).toBe(100);
    expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", "completed", 100],
    ["failed", "failed", 64],
  ] as const)(
    "maps a known-job DELETE %s response to %s",
    async (responseStatus, expectedState, expectedProgress) => {
      vi.mocked(queueTrackDownloads).mockResolvedValue({
        results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
      });
      vi.mocked(getDownloadJobStatus).mockResolvedValue(active);
      vi.mocked(cancelDownloadJob)
        .mockResolvedValueOnce({
          jobId: "job-1",
          status: responseStatus,
        })
        .mockResolvedValueOnce({ jobId: "job-1", status: "canceled" });
      const { result } = renderHook(() => useTrackDownload());

      await act(async () => {
        await result.current.start(track);
      });
      await flushMicrotasks();
      expect(result.current.state).toBe("active");

      await act(async () => {
        await result.current.cancel();
      });

      expect(result.current.state).toBe(expectedState);
      expect(result.current.progress).toBe(expectedProgress);
      expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
      expect(window.location.assign).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.cancel();
      });

      expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds an in-flight DELETE, restores the exact job, and permits one retry without a late unhandled rejection", async () => {
    const pendingCancel = deferred<{
      jobId: string;
      status: "canceled";
    }>();
    const unhandledRejection = vi.fn();
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      unhandledRejection(event.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    try {
      vi.mocked(queueTrackDownloads).mockResolvedValue({
        results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
      });
      vi.mocked(getDownloadJobStatus).mockResolvedValue(active);
      vi.mocked(cancelDownloadJob)
        .mockReturnValueOnce(pendingCancel.promise)
        .mockResolvedValueOnce({ jobId: "job-1", status: "canceled" });
      const { result } = renderHook(() => useTrackDownload());

      await act(async () => {
        await result.current.start(track);
      });
      await flushMicrotasks();

      let firstCancel!: Promise<void>;
      let duplicateCancel!: Promise<void>;
      await act(async () => {
        firstCancel = result.current.cancel();
        duplicateCancel = result.current.cancel();
        await Promise.resolve();
      });
      const firstRequest = vi.mocked(cancelDownloadJob).mock.calls[0][1];

      expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect((firstRequest?.signal as AbortSignal).aborted).toBe(true);
      await act(async () => {
        await Promise.all([firstCancel, duplicateCancel]);
      });
      expect(result.current.state).toBe("active");
      expect(result.current.progress).toBe(64);
      expect(vi.getTimerCount()).toBe(1);

      await act(async () => {
        await result.current.cancel();
      });
      expect(cancelDownloadJob).toHaveBeenCalledTimes(2);
      expect(cancelDownloadJob).toHaveBeenNthCalledWith(
        2,
        "job-1",
        expect.any(Object),
      );
      expect(result.current.state).toBe("canceled");

      pendingCancel.reject(new Error("late cancellation failure"));
      await flushMicrotasks();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    }
  });

  it("resumes polling the exact job after a failed DELETE without issuing another DELETE", async () => {
    const resumedPoll = deferred<DownloadJobStatus>();
    const error = { status: 503, data: { error: "bounded_error" } };
    vi.mocked(queueTrackDownloads).mockResolvedValue({
      results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
    });
    vi.mocked(getDownloadJobStatus)
      .mockResolvedValueOnce(active)
      .mockReturnValueOnce(resumedPoll.promise);
    vi.mocked(cancelDownloadJob).mockRejectedValue(error);
    const { result } = renderHook(() => useTrackDownload());

    await act(async () => {
      await result.current.start(track);
    });
    await flushMicrotasks();
    expect(result.current.state).toBe("active");
    expect(result.current.progress).toBe(64);

    await act(async () => {
      await result.current.cancel();
    });

    expect(getDownloadJobStatus).toHaveBeenCalledTimes(2);
    expect(getDownloadJobStatus).toHaveBeenLastCalledWith(
      "job-1",
      expect.objectContaining({ credentials: "include", method: "GET" }),
    );
    expect(cancelDownloadJob).toHaveBeenCalledTimes(1);

    await act(async () => {
      resumedPoll.resolve({ status: "completed", progress: 100 });
    });
    await flushMicrotasks();

    expect(result.current.state).toBe("completed");
    expect(result.current.progress).toBe(100);
    expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, true],
    [403, true],
    [409, true],
    [503, false],
  ])(
    "restores an active known job after DELETE %s and retries the same job",
    async (status, shouldReportAuth) => {
      const error = { status, data: { error: "bounded_error" } };
      vi.mocked(queueTrackDownloads).mockResolvedValue({
        results: [{ trackId: track.id, jobId: "job-1", position: 1 }],
      });
      vi.mocked(getDownloadJobStatus).mockResolvedValue(active);
      vi.mocked(cancelDownloadJob)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ jobId: "job-1", status: "canceled" });
      const { result } = renderHook(() => useTrackDownload());

      await act(async () => {
        await result.current.start(track);
      });
      await flushMicrotasks();
      expect(result.current.state).toBe("active");
      expect(result.current.progress).toBe(64);

      await act(async () => {
        await result.current.cancel();
      });

      expect(result.current.state).toBe("active");
      expect(result.current.progress).toBe(64);
      if (shouldReportAuth) {
        expect(reportTfAuthError).toHaveBeenCalledWith(error);
      } else {
        expect(reportTfAuthError).not.toHaveBeenCalled();
      }

      await act(async () => {
        await result.current.cancel();
      });

      expect(cancelDownloadJob).toHaveBeenCalledTimes(2);
      expect(cancelDownloadJob).toHaveBeenNthCalledWith(
        1,
        "job-1",
        expect.any(Object),
      );
      expect(cancelDownloadJob).toHaveBeenNthCalledWith(
        2,
        "job-1",
        expect.any(Object),
      );
      expect(result.current.state).toBe("canceled");
      expect(window.location.assign).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    ["completed", "completed", 100],
    ["failed", "failed", 0],
  ] as const)(
    "maps a late-ack compensating DELETE %s response to %s",
    async (responseStatus, expectedState, expectedProgress) => {
      const queued = deferred<{
        results: Array<{ trackId: string; jobId: string; position: number }>;
      }>();
      vi.mocked(queueTrackDownloads).mockReturnValue(queued.promise);
      vi.mocked(cancelDownloadJob)
        .mockResolvedValueOnce({
          jobId: "job-late",
          status: responseStatus,
        })
        .mockResolvedValueOnce({ jobId: "job-late", status: "canceled" });
      const { result } = renderHook(() => useTrackDownload());

      let startPromise!: Promise<void>;
      await act(async () => {
        startPromise = result.current.start(track);
        await Promise.resolve();
        await result.current.cancel();
      });
      expect(result.current.state).toBe("canceled");

      await act(async () => {
        queued.resolve({
          results: [{ trackId: track.id, jobId: "job-late", position: 1 }],
        });
        await startPromise;
      });

      expect(result.current.state).toBe(expectedState);
      expect(result.current.progress).toBe(expectedProgress);
      expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
      expect(getDownloadJobStatus).not.toHaveBeenCalled();
      expect(window.location.assign).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.cancel();
      });

      expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [401, true],
    [503, false],
  ])(
    "resumes exact-job polling after late-ack compensating DELETE %s fails",
    async (status, shouldReportAuth) => {
      const queued = deferred<{
        results: Array<{ trackId: string; jobId: string; position: number }>;
      }>();
      const error = { status, data: { error: "bounded_error" } };
      vi.mocked(queueTrackDownloads).mockReturnValue(queued.promise);
      vi.mocked(cancelDownloadJob).mockRejectedValueOnce(error);
      vi.mocked(getDownloadJobStatus).mockResolvedValue({
        status: "completed",
        progress: 100,
      });
      const { result } = renderHook(() => useTrackDownload());

      let startPromise!: Promise<void>;
      await act(async () => {
        startPromise = result.current.start(track);
        await Promise.resolve();
        await result.current.cancel();
      });
      expect(result.current.state).toBe("canceled");

      await act(async () => {
        queued.resolve({
          results: [{ trackId: track.id, jobId: "job-late", position: 1 }],
        });
        await startPromise;
      });
      await flushMicrotasks();

      expect(queueTrackDownloads).toHaveBeenCalledTimes(1);
      expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
      expect(cancelDownloadJob).toHaveBeenCalledWith(
        "job-late",
        expect.objectContaining({ credentials: "include", method: "DELETE" }),
      );
      expect(getDownloadJobStatus).toHaveBeenCalledTimes(1);
      expect(getDownloadJobStatus).toHaveBeenCalledWith(
        "job-late",
        expect.objectContaining({ credentials: "include", method: "GET" }),
      );
      expect(result.current.state).toBe("completed");
      expect(result.current.progress).toBe(100);
      if (shouldReportAuth) {
        expect(reportTfAuthError).toHaveBeenCalledWith(error);
      } else {
        expect(reportTfAuthError).not.toHaveBeenCalled();
      }
      expect(window.location.assign).not.toHaveBeenCalled();

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(queueTrackDownloads).toHaveBeenCalledTimes(1);
      expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
      expect(getDownloadJobStatus).toHaveBeenCalledTimes(1);
      expect(result.current.state).toBe("completed");
      expect(window.location.assign).not.toHaveBeenCalled();
    },
  );

  it("suppresses restart until the canceled queue acknowledgement settles", async () => {
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
      await result.current.start(track);
    });

    expect(queueTrackDownloads).toHaveBeenCalledTimes(1);
    expect(getDownloadJobStatus).not.toHaveBeenCalled();
    expect(result.current.state).toBe("canceled");

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
    expect(queueTrackDownloads).toHaveBeenCalledTimes(1);
    expect(getDownloadJobStatus).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.start(track);
    });
    await flushMicrotasks();

    expect(queueTrackDownloads).toHaveBeenCalledTimes(2);
    expect(getDownloadJobStatus).toHaveBeenCalledTimes(1);
    expect(getDownloadJobStatus).toHaveBeenCalledWith(
      "job-current",
      expect.any(Object),
    );
    expect(window.location.assign).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("completed");
  });

  it("keeps repeated pre-ack starts and cancels bounded to one queue request", async () => {
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
      void result.current.start(track);
      await result.current.cancel();
      void result.current.start(track);
      await Promise.resolve();
    });
    expect(queueTrackDownloads).toHaveBeenCalledTimes(1);
    await act(async () => {
      queued.resolve({
        results: [{ trackId: track.id, jobId: "job-late", position: 1 }],
      });
      await startPromise;
    });

    expect(cancelDownloadJob).toHaveBeenCalledTimes(1);
    expect(queueTrackDownloads).toHaveBeenCalledTimes(1);
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
