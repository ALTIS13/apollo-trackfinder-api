import { randomBytes } from "node:crypto";

import { createModuleHeartbeatSignature } from "@workspace/module-runtime-contract";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const HEARTBEAT_PATH =
  "/api/internal/modules/download-worker/heartbeat";
const MAX_COUNTER = 1_000_000;

export type TfDownloadWorkerHeartbeatStatus =
  | "healthy"
  | "warning"
  | "degraded";

export interface TfDownloadWorkerHeartbeatObservation {
  readonly status: TfDownloadWorkerHeartbeatStatus;
  readonly jobsPerMinute: number;
}

export interface TfDownloadWorkerHeartbeatOptions {
  readonly apiOrigin: string;
  readonly secret: string;
  readonly version: string;
  readonly deployedAt?: string;
  readonly ready: () => boolean | Promise<boolean>;
  readonly observe: () => TfDownloadWorkerHeartbeatObservation;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly createNonce?: () => string;
}

export interface TfDownloadWorkerHeartbeatHandle {
  stop(): Promise<void>;
}

function boundedObservation(
  value: TfDownloadWorkerHeartbeatObservation,
): TfDownloadWorkerHeartbeatObservation {
  const status =
    value.status === "healthy" ||
    value.status === "warning" ||
    value.status === "degraded"
      ? value.status
      : "degraded";
  const jobsPerMinute =
    Number.isFinite(value.jobsPerMinute) &&
    value.jobsPerMinute >= 0 &&
    value.jobsPerMinute <= MAX_COUNTER
      ? Math.floor(value.jobsPerMinute)
      : 0;
  return { status, jobsPerMinute };
}

export function startTfDownloadWorkerHeartbeat(
  options: TfDownloadWorkerHeartbeatOptions,
): TfDownloadWorkerHeartbeatHandle {
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const createNonce =
    options.createNonce ?? (() => randomBytes(32).toString("base64url"));
  let stopped = false;
  let active: Promise<void> | undefined;
  let activeController: AbortController | undefined;

  const attempt = async (): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    try {
      if (stopped || !(await options.ready()) || stopped) return;
      const observation = boundedObservation(options.observe());
      const rawBody = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          status: observation.status,
          version: options.version,
          ...(options.deployedAt === undefined
            ? {}
            : { deployedAt: options.deployedAt }),
          requestsPerMinute: observation.jobsPerMinute,
        }),
        "utf8",
      );
      const timestamp = String(Math.floor(now() / 1_000));
      const nonce = createNonce();
      const signature = createModuleHeartbeatSignature({
        moduleId: "download-worker",
        timestamp,
        nonce,
        rawBody,
        secret: options.secret,
      });
      controller = new AbortController();
      activeController = controller;
      timeout = setTimeout(() => controller?.abort(), HEARTBEAT_TIMEOUT_MS);
      const response = await send(
        new URL(HEARTBEAT_PATH, options.apiOrigin).toString(),
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-apollo-heartbeat-timestamp": timestamp,
            "x-apollo-heartbeat-nonce": nonce,
            "x-apollo-heartbeat-signature": signature,
          },
          body: rawBody.toString("utf8"),
        },
      );
      try {
        const cancellation = response.body?.cancel();
        void cancellation?.catch(() => undefined);
      } catch {
        // Response disposal must not affect readiness or future heartbeats.
      }
    } catch {
      // Transport and readiness failures are retried on the next fixed tick.
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (activeController === controller) activeController = undefined;
    }
  };

  const launch = (): void => {
    if (stopped || active !== undefined) return;
    const current = attempt();
    active = current;
    void current.finally(() => {
      if (active === current) active = undefined;
    });
  };

  const timer = setInterval(launch, HEARTBEAT_INTERVAL_MS);
  launch();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      activeController?.abort();
      await active;
    },
  };
}
