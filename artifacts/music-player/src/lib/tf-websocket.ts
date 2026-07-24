import {
  TfApiError,
  normalizeTfApiError,
} from "./tf-session-client";

const INITIAL_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const TERMINAL_ERROR_KINDS = new Set([
  "unauthenticated",
  "forbidden",
  "unavailable",
]);
const POLICY_REVOKED_CLOSE = { code: 4403, reason: "policy_revoked" };
const POLICY_UNAVAILABLE_CLOSE = { code: 1013, reason: "policy_unavailable" };
const BUFFER_UNAVAILABLE_CLOSE = { code: 1013, reason: "buffer_unavailable" };

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
    this.clearReconnectTimer();

    const socket = this.socket;
    this.socket = null;
    if (socket !== null) this.detachSocket(socket, true);
  }

  private async connect(attempt: number): Promise<void> {
    if (!this.running || attempt !== this.attempt) return;

    try {
      const ticket = await this.options.createTicket();
      if (!this.running || attempt !== this.attempt) return;

      const socket = this.options.createSocket(this.options.buildUrl(ticket));
      if (!this.running || attempt !== this.attempt) {
        this.detachSocket(socket, true);
        return;
      }

      this.socket = socket;
      let opened = false;
      socket.onopen = () => {
        if (!this.ownsSocket(attempt, socket)) return;
        opened = true;
        this.delayMs = INITIAL_RECONNECT_DELAY_MS;
      };
      socket.onmessage = (event) => {
        if (!this.ownsSocket(attempt, socket)) return;
        this.options.onMessage(event);
      };
      socket.onerror = () => {
        if (!this.ownsSocket(attempt, socket)) return;
        socket.close();
      };
      socket.onclose = (event) => {
        if (!this.ownsSocket(attempt, socket)) return;

        this.socket = null;
        this.detachSocket(socket, false);

        const terminalError = terminalCloseError(event);
        if (terminalError !== null) {
          this.terminate(attempt, terminalError);
          return;
        }
        if (!opened && !isClosePair(event, BUFFER_UNAVAILABLE_CLOSE)) {
          this.terminate(
            attempt,
            new TfApiError(503, "websocket_unavailable", "unavailable"),
          );
          return;
        }
        this.scheduleReconnect(attempt);
      };
    } catch (error) {
      if (!this.running || attempt !== this.attempt) return;
      const apiError = normalizeTfApiError(error);
      if (TERMINAL_ERROR_KINDS.has(apiError.kind)) {
        this.terminate(attempt, apiError);
        return;
      }
      this.scheduleReconnect(attempt);
    }
  }

  private ownsSocket(attempt: number, socket: WebSocket): boolean {
    return this.running
      && attempt === this.attempt
      && this.socket === socket;
  }

  private detachSocket(socket: WebSocket, close: boolean): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (close && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
  }

  private terminate(attempt: number, error: TfApiError): void {
    if (!this.running || attempt !== this.attempt) return;

    this.running = false;
    this.attempt += 1;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) this.detachSocket(socket, true);
    this.options.onTerminalError(error);
  }

  private clearReconnectTimer(): void {
    if (this.timer === null) return;
    (this.options.cancelSchedule ?? window.clearTimeout)(this.timer);
    this.timer = null;
  }

  private scheduleReconnect(attempt: number): void {
    if (!this.running || attempt !== this.attempt || this.timer !== null) return;

    const delay = this.delayMs;
    this.delayMs = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    this.timer = (this.options.schedule ?? window.setTimeout)(() => {
      this.timer = null;
      if (!this.running || attempt !== this.attempt) return;
      const nextAttempt = ++this.attempt;
      void this.connect(nextAttempt);
    }, delay);
  }
}

function terminalCloseError(event: CloseEvent): TfApiError | null {
  if (isClosePair(event, POLICY_REVOKED_CLOSE)) {
    return new TfApiError(403, POLICY_REVOKED_CLOSE.reason, "forbidden");
  }
  if (isClosePair(event, POLICY_UNAVAILABLE_CLOSE)) {
    return new TfApiError(503, POLICY_UNAVAILABLE_CLOSE.reason, "unavailable");
  }
  return null;
}

function isClosePair(
  event: CloseEvent,
  expected: { code: number; reason: string },
): boolean {
  return event.code === expected.code && event.reason === expected.reason;
}
