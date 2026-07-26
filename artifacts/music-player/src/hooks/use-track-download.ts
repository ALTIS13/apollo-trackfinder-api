import { useCallback, useEffect, useRef, useState } from "react";
import {
  DownloadQuality,
  getDownloadJobStatus,
  getGetDownloadJobFileUrl,
  queueTrackDownloads,
  cancelDownloadJob,
  type TrackResult,
} from "@workspace/api-client-react";
import { apiUrl } from "@/lib/api-config";
import { reportTfAuthError, tfRequestInit } from "@/lib/tf-session-client";

export type TrackDownloadState =
  | "idle"
  | "waiting"
  | "active"
  | "completed"
  | "failed"
  | "canceled";

export interface TrackDownloadController {
  readonly state: TrackDownloadState;
  readonly progress: number;
  readonly start: (
    track: TrackResult,
    quality?: DownloadQuality,
  ) => Promise<void>;
  readonly cancel: () => Promise<void>;
}

interface DownloadSnapshot {
  state: TrackDownloadState;
  progress: number;
}

interface PendingQueueGeneration {
  readonly abort: AbortController;
  canceled: boolean;
  compensationStarted: boolean;
}

const INITIAL_SNAPSHOT: DownloadSnapshot = { state: "idle", progress: 0 };
const POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000, 5_000] as const;

function clampProgress(progress: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0));
}

function fileNavigationUrl(jobId: string): string {
  return apiUrl(getGetDownloadJobFileUrl(jobId).replace(/^\/api(?=\/)/, ""));
}

export function useTrackDownload(): TrackDownloadController {
  const [snapshot, setSnapshot] = useState<DownloadSnapshot>(INITIAL_SNAPSHOT);
  const mountedRef = useRef(true);
  const snapshotRef = useRef(snapshot);
  const generationRef = useRef(0);
  const jobIdRef = useRef<string | null>(null);
  const pendingQueuesRef = useRef(new Map<number, PendingQueueGeneration>());
  const cancelAbortControllersRef = useRef(new Set<AbortController>());
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollInFlightRef = useRef(false);
  const navigationGenerationRef = useRef<number | null>(null);

  const isCurrent = useCallback(
    (generation: number, jobId?: string) =>
      mountedRef.current &&
      generation === generationRef.current &&
      (jobId === undefined || jobId === jobIdRef.current),
    [],
  );

  const commit = useCallback(
    (generation: number, next: DownloadSnapshot) => {
      if (!isCurrent(generation)) return;
      snapshotRef.current = next;
      setSnapshot(next);
    },
    [isCurrent],
  );

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    pollInFlightRef.current = false;
  }, []);

  const cancelJob = useCallback(
    async (jobId: string, reportGeneration: number | null): Promise<void> => {
      const abort = new AbortController();
      cancelAbortControllersRef.current.add(abort);
      try {
        await cancelDownloadJob(
          jobId,
          tfRequestInit({ method: "DELETE", signal: abort.signal }),
        );
      } catch (error) {
        if (
          !abort.signal.aborted &&
          reportGeneration !== null &&
          mountedRef.current &&
          reportGeneration === generationRef.current
        ) {
          reportTfAuthError(error);
        }
      } finally {
        cancelAbortControllersRef.current.delete(abort);
      }
    },
    [],
  );

  const start = useCallback(
    async (
      track: TrackResult,
      quality: DownloadQuality = DownloadQuality.NUMBER_320,
    ) => {
      if (
        snapshotRef.current.state === "waiting" ||
        snapshotRef.current.state === "active"
      ) {
        return;
      }

      const generation = ++generationRef.current;
      stopPolling();
      const pendingQueue: PendingQueueGeneration = {
        abort: new AbortController(),
        canceled: false,
        compensationStarted: false,
      };
      pendingQueuesRef.current.set(generation, pendingQueue);
      jobIdRef.current = null;
      navigationGenerationRef.current = null;
      commit(generation, { state: "waiting", progress: 0 });

      const poll = async (jobId: string, attempt: number): Promise<void> => {
        if (!isCurrent(generation, jobId) || pollInFlightRef.current) return;

        const pollAbort = new AbortController();
        pollAbortRef.current = pollAbort;
        pollInFlightRef.current = true;
        let nextDelay: number | null = null;

        try {
          const status = await getDownloadJobStatus(
            jobId,
            tfRequestInit({
              method: "GET",
              signal: pollAbort.signal,
            }),
          );
          if (!isCurrent(generation, jobId)) return;

          const progress = clampProgress(status.progress);
          if (status.status === "waiting" || status.status === "active") {
            commit(generation, { state: status.status, progress });
            nextDelay =
              POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)];
          } else if (status.status === "completed") {
            commit(generation, { state: "completed", progress: 100 });
            if (navigationGenerationRef.current !== generation) {
              navigationGenerationRef.current = generation;
              window.location.assign(fileNavigationUrl(jobId));
            }
          } else {
            commit(generation, { state: status.status, progress });
          }
        } catch (error) {
          if (!isCurrent(generation, jobId) || pollAbort.signal.aborted) return;
          reportTfAuthError(error);
          commit(generation, {
            state: "failed",
            progress: snapshotRef.current.progress,
          });
        } finally {
          if (pollAbortRef.current === pollAbort) {
            pollAbortRef.current = null;
            pollInFlightRef.current = false;
          }
        }

        if (nextDelay !== null && isCurrent(generation, jobId)) {
          pollTimerRef.current = setTimeout(() => {
            pollTimerRef.current = null;
            void poll(jobId, attempt + 1);
          }, nextDelay);
        }
      };

      try {
        const response = await queueTrackDownloads(
          {
            tracks: [
              {
                trackId: track.id,
                artist: track.artist,
                title: track.title,
                quality,
              },
            ],
          },
          tfRequestInit({ method: "POST", signal: pendingQueue.abort.signal }),
        );
        const queueResult = response.results[0];
        if (queueResult && "error" in queueResult) {
          if (
            !pendingQueue.canceled &&
            isCurrent(generation) &&
            !pendingQueue.abort.signal.aborted
          ) {
            commit(generation, { state: "failed", progress: 0 });
          }
          return;
        }
        const jobId = queueResult?.jobId;

        if (pendingQueue.canceled) {
          if (
            jobId &&
            mountedRef.current &&
            !pendingQueue.abort.signal.aborted &&
            !pendingQueue.compensationStarted
          ) {
            pendingQueue.compensationStarted = true;
            await cancelJob(jobId, null);
          }
          return;
        }
        if (!isCurrent(generation) || pendingQueue.abort.signal.aborted) return;
        if (!jobId) throw new Error("download queue returned no job");
        jobIdRef.current = jobId;
        void poll(jobId, 0);
      } catch (error) {
        if (
          pendingQueue.canceled ||
          !isCurrent(generation) ||
          pendingQueue.abort.signal.aborted
        ) {
          return;
        }
        reportTfAuthError(error);
        commit(generation, { state: "failed", progress: 0 });
      } finally {
        if (pendingQueuesRef.current.get(generation) === pendingQueue) {
          pendingQueuesRef.current.delete(generation);
        }
      }
    },
    [cancelJob, commit, isCurrent, stopPolling],
  );

  const cancel = useCallback(async () => {
    const pendingQueue = pendingQueuesRef.current.get(generationRef.current);
    if (pendingQueue) pendingQueue.canceled = true;
    const jobId = jobIdRef.current;
    const generation = ++generationRef.current;
    stopPolling();
    jobIdRef.current = null;
    navigationGenerationRef.current = null;
    if (mountedRef.current) {
      snapshotRef.current = {
        state: "canceled",
        progress: snapshotRef.current.progress,
      };
      setSnapshot(snapshotRef.current);
    }

    if (jobId === null) return;
    await cancelJob(jobId, generation);
  }, [cancelJob, stopPolling]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      generationRef.current += 1;
      stopPolling();
      for (const pendingQueue of pendingQueuesRef.current.values()) {
        pendingQueue.abort.abort();
      }
      pendingQueuesRef.current.clear();
      for (const abort of cancelAbortControllersRef.current) abort.abort();
      cancelAbortControllersRef.current.clear();
    },
    [stopPolling],
  );

  return { ...snapshot, start, cancel };
}
