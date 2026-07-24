import {
  type TfApiError,
  normalizeTfApiError,
} from "./tf-session-client";

const INITIAL_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const TERMINAL_ERROR_KINDS = new Set([
  "unauthenticated",
  "forbidden",
  "unavailable",
]);

export interface TfWebSocketLifecycleOptions {
  createTicket: () => Promise<string>;
  buildUrl: (ticket: string) => string;
  createSocket: (url: string) => WebSocket;
  onMessage: (event: MessageEvent) => void;
  onTerminalError: (error: TfApiError) => void;
  schedule?: typeof window.setTimeout;
  cancelSchedule?: typeof window.clearTimeout;
}

export class TfWebSocketLifecycle {
  private running = false;
  private attempt = 0;
  private delayMs = INITIAL_RECONNECT_DELAY_MS;
  private timer: number | null = null;
  private socket: WebSocket | null = null;

  constructor(private readonly options: TfWebSocketLifecycleOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.delayMs = INITIAL_RECONNECT_DELAY_MS;
    const attempt = ++this.attempt;
    void this.connect(attempt);
  }

  stop(): void {
    this.running = false;
    this.attempt += 1;

    if (this.timer !== null) {
      (this.options.cancelSchedule ?? window.clearTimeout)(this.timer);
      this.timer = null;
    }

    if (this.socket !== null) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }

  private async connect(attempt: number): Promise<void> {
    if (!this.running || attempt !== this.attempt) return;

    try {
      const ticket = await this.options.createTicket();
      if (!this.running || attempt !== this.attempt) return;

      const socket = this.options.createSocket(this.options.buildUrl(ticket));
      this.socket = socket;
      socket.onopen = () => {
        this.delayMs = INITIAL_RECONNECT_DELAY_MS;
      };
      socket.onmessage = this.options.onMessage;
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        this.scheduleReconnect();
      };
    } catch (error) {
      const apiError = normalizeTfApiError(error);
      if (TERMINAL_ERROR_KINDS.has(apiError.kind)) {
        this.running = false;
        this.options.onTerminalError(apiError);
        return;
      }
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.timer !== null) return;

    const delay = this.delayMs;
    this.delayMs = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    this.timer = (this.options.schedule ?? window.setTimeout)(() => {
      this.timer = null;
      if (!this.running) return;
      const attempt = ++this.attempt;
      void this.connect(attempt);
    }, delay);
  }
}
