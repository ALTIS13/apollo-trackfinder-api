export interface RedisRuntimeClient {
  readonly status: string;
  connect(): Promise<unknown>;
  disconnect(): void;
  on(event: string, listener: (...args: readonly unknown[]) => void): unknown;
}

export interface RedisReadinessLogger {
  error(object: Record<string, unknown>, message?: string): void;
}

export interface RedisReadiness {
  isReady(): boolean;
}

const ERROR_LOG_INTERVAL_MS = 30_000;

export class RedisConnectionReadiness implements RedisReadiness {
  private ready = false;
  private started = false;
  private lastErrorLoggedAt: number | null = null;

  constructor(
    private readonly redis: RedisRuntimeClient,
    private readonly logger: RedisReadinessLogger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.redis.on("ready", () => {
      this.ready = true;
    });
    this.redis.on("error", () => {
      this.ready = false;
      this.logUnavailable();
    });
    this.redis.on("close", () => {
      this.ready = false;
    });
    this.redis.on("end", () => {
      this.ready = false;
    });
    this.redis.on("reconnecting", () => {
      this.ready = false;
    });

    if (this.redis.status === "ready") {
      this.ready = true;
    } else if (this.redis.status === "wait") {
      void this.connect();
    }
  }

  isReady(): boolean {
    return this.ready && this.redis.status === "ready";
  }

  stop(): void {
    this.ready = false;
    this.redis.disconnect();
  }

  private async connect(): Promise<void> {
    try {
      await this.redis.connect();
      this.ready = this.redis.status === "ready";
    } catch {
      this.ready = false;
      this.logUnavailable();
    }
  }

  private logUnavailable(): void {
    const now = this.now();
    if (
      this.lastErrorLoggedAt !== null &&
      now - this.lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.lastErrorLoggedAt = now;
    this.logger.error({ component: "redis" }, "redis unavailable");
  }
}

export function combineRuntimeReadiness(
  redis: RedisReadiness,
  databaseReadiness: () => Promise<boolean>,
): () => Promise<boolean> {
  return async () => redis.isReady() && (await databaseReadiness());
}
