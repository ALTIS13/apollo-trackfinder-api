import { randomBytes } from "node:crypto";

import { createModuleHeartbeatSignature } from "@workspace/module-runtime-contract";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const HEARTBEAT_PATH = "/api/internal/modules/account-integrations/heartbeat";

export interface TfIntegrationsHeartbeatOptions {
  readonly apiOrigin: string;
  readonly secret: string;
  readonly version: string;
  readonly deployedAt?: string;
  readonly ready: () => Promise<boolean>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly createNonce?: () => string;
}

export interface TfIntegrationsHeartbeatHandle {
  stop(): Promise<void>;
}

export interface TfIntegrationsShutdownOptions {
  readonly closeListener: () => Promise<void>;
  readonly heartbeat: TfIntegrationsHeartbeatHandle;
  readonly closePool: () => Promise<void>;
}

export function startTfIntegrationsHeartbeat(
  options: TfIntegrationsHeartbeatOptions,
): TfIntegrationsHeartbeatHandle {
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const createNonce =
    options.createNonce ?? (() => randomBytes(32).toString("base64url"));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let active: Promise<void> | undefined;

  const attempt = async (): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let activeController: AbortController | undefined;
    try {
      if (stopped || !(await options.ready())) return;
      const rawBody = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          status: "healthy",
          version: options.version,
          ...(options.deployedAt === undefined
            ? {}
            : { deployedAt: options.deployedAt }),
          requestsPerMinute: 0,
        }),
        "utf8",
      );
      const timestamp = String(Math.floor(now() / 1_000));
      const nonce = createNonce();
      const signature = createModuleHeartbeatSignature({
        moduleId: "account-integrations",
        timestamp,
        nonce,
        rawBody,
        secret: options.secret,
      });
      activeController = new AbortController();
      controller = activeController;
      timeout = setTimeout(
        () => activeController?.abort(),
        HEARTBEAT_TIMEOUT_MS,
      );
      const response = await send(
        new URL(HEARTBEAT_PATH, options.apiOrigin).toString(),
        {
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
        },
      );
      try {
        const cancellation = response.body?.cancel();
        void cancellation?.catch(() => undefined);
      } catch {
        // Body disposal must not affect future attempts.
      }
    } catch {
      // Heartbeat transport and readiness failures are retried independently.
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (controller === activeController) controller = undefined;
    }
  };

  const launchAttempt = (): void => {
    if (stopped || active !== undefined) return;
    const current = attempt();
    active = current;
    void current.finally(() => {
      if (active === current) active = undefined;
    });
  };

  timer = setInterval(launchAttempt, HEARTBEAT_INTERVAL_MS);
  launchAttempt();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      controller?.abort();
      await active;
    },
  };
}

export function createTfIntegrationsShutdown(
  options: TfIntegrationsShutdownOptions,
): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= (async () => {
      try {
        await options.closeListener();
      } finally {
        try {
          await options.heartbeat.stop();
        } finally {
          await options.closePool();
        }
      }
    })();
    return shutdown;
  };
}
