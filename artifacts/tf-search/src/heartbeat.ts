import { randomBytes } from "node:crypto";
import { createModuleHeartbeatSignature } from "@workspace/module-runtime-contract";
import type { SearchService } from "./search-service.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const HEARTBEAT_PATH = "/api/internal/modules/search-media/heartbeat";

export interface HeartbeatOptions {
  readonly apiOrigin: string;
  readonly secret: string;
  readonly version: string;
  readonly deployedAt?: string;
  readonly ready: () => boolean;
  readonly telemetry: SearchService["telemetry"];
  readonly parserTelemetry?: NonNullable<SearchService["parserTelemetry"]>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly createNonce?: () => string;
}

export interface SearchHeartbeatHandle {
  stop(): Promise<void>;
}

export function startSearchHeartbeat(options: HeartbeatOptions): SearchHeartbeatHandle {
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const createNonce = options.createNonce ?? (() => randomBytes(32).toString("base64url"));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let active: Promise<void> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      launchAttempt();
    }, HEARTBEAT_INTERVAL_MS);
  };

  const attempt = async (): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let activeController: AbortController | undefined;
    try {
      if (stopped || !options.ready()) return;
      const telemetry = options.telemetry();
      const parsers = options.parserTelemetry?.();
      const rawBody = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          status: telemetry.status,
          version: options.version,
          ...(options.deployedAt === undefined ? {} : { deployedAt: options.deployedAt }),
          requestsPerMinute: telemetry.requestsPerMinute,
          ...(parsers === undefined ? {} : { parsers }),
        }),
        "utf8",
      );
      const timestamp = String(Math.floor(now() / 1_000));
      const nonce = createNonce();
      const signature = createModuleHeartbeatSignature({
        moduleId: "search-media",
        timestamp,
        nonce,
        rawBody,
        secret: options.secret,
      });
      activeController = new AbortController();
      controller = activeController;
      timeout = setTimeout(() => activeController?.abort(), HEARTBEAT_TIMEOUT_MS);
      const response = await send(new URL(HEARTBEAT_PATH, options.apiOrigin).toString(), {
        method: "POST",
        redirect: "error",
        signal: activeController.signal,
        headers: {
          "content-type": "application/json",
          "x-apollo-heartbeat-timestamp": timestamp,
          "x-apollo-heartbeat-nonce": nonce,
          "x-apollo-heartbeat-signature": signature,
        },
        body: rawBody.toString("utf8"),
      });
      try {
        const cancellation = response.body?.cancel();
        void cancellation?.catch(() => undefined);
      } catch {
        // Body disposal must never affect readiness or the next heartbeat attempt.
      }
    } catch {
      // The next scheduled attempt deliberately remains independent of local or transport failure.
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (controller === activeController) controller = undefined;
      if (!stopped) schedule();
    }
  };

  const launchAttempt = (): void => {
    const current = attempt();
    active = current;
    void current.then(
      () => {
        if (active === current) active = undefined;
      },
      () => {
        if (active === current) active = undefined;
      },
    );
  };

  launchAttempt();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      await active;
    },
  };
}
