import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TfApiError,
  buildTfWebSocketUrl,
} from "./tf-session-client";
import { TfWebSocketLifecycle } from "./tf-websocket";

const FIRST_TICKET = "a".repeat(43);
const SECOND_TICKET = "b".repeat(43);
const THIRD_TICKET = "c".repeat(43);

class FakeSocket {
  readonly url: string;
  readyState = WebSocket.CONNECTING;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }

  emitClose(code = 1000, reason = ""): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.call(
      this as unknown as WebSocket,
      new CloseEvent("close", { code, reason }),
    );
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(ticketValues: string[] = [FIRST_TICKET]) {
  const sockets: FakeSocket[] = [];
  const createTicket = vi.fn();
  for (const ticket of ticketValues) {
    createTicket.mockResolvedValueOnce(ticket);
  }
  const buildUrl = vi.fn(buildTfWebSocketUrl);
  const createSocket = vi.fn((url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const onMessage = vi.fn();
  const onTerminalError = vi.fn();
  const schedule = vi.fn((handler: TimerHandler, delay?: number) =>
    window.setTimeout(handler, delay));
  const cancelSchedule = vi.fn((timer: number) => window.clearTimeout(timer));
  const lifecycle = new TfWebSocketLifecycle({
    createTicket,
    buildUrl,
    createSocket,
    onMessage,
    onTerminalError,
    schedule,
    cancelSchedule,
  });

  return {
    lifecycle,
    sockets,
    createTicket,
    buildUrl,
    createSocket,
    onMessage,
    onTerminalError,
    schedule,
    cancelSchedule,
  };
}

describe("TfWebSocketLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests a fresh ticket before the initial socket", async () => {
    const pendingTicket = deferred<string>();
    const harness = createHarness();
    harness.createTicket.mockReset();
    harness.createTicket.mockReturnValueOnce(pendingTicket.promise);

    harness.lifecycle.start();

    expect(harness.createTicket).toHaveBeenCalledOnce();
    expect(harness.createSocket).not.toHaveBeenCalled();

    pendingTicket.resolve(FIRST_TICKET);
    await flushPromises();

    expect(harness.buildUrl).toHaveBeenCalledWith(FIRST_TICKET);
    expect(harness.createSocket).toHaveBeenCalledOnce();
  });

  it("requests a different fresh ticket before every reconnect", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET, THIRD_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
    harness.sockets[0].open();
    harness.sockets[0].emitClose();

    await vi.advanceTimersByTimeAsync(3_000);
    harness.sockets[1].open();
    harness.sockets[1].emitClose();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.createTicket).toHaveBeenCalledTimes(3);
    expect(harness.buildUrl.mock.calls.map(([ticket]) => ticket)).toEqual([
      FIRST_TICKET,
      SECOND_TICKET,
      THIRD_TICKET,
    ]);
  });

  it("uses a URL whose only query key is ticket", async () => {
    const harness = createHarness();

    harness.lifecycle.start();
    await flushPromises();

    const url = new URL(harness.sockets[0].url);
    expect([...url.searchParams.keys()]).toEqual(["ticket"]);
    expect(url.searchParams.get("ticket")).toBe(FIRST_TICKET);
  });

  it("backs off reconnects from 3000ms up to 30000ms", async () => {
    const harness = createHarness([
      FIRST_TICKET,
      SECOND_TICKET,
      THIRD_TICKET,
      "d".repeat(43),
      "e".repeat(43),
      "f".repeat(43),
      "g".repeat(43),
    ]);
    const expectedDelays = [3_000, 6_000, 12_000, 24_000, 30_000, 30_000];

    harness.lifecycle.start();
    await flushPromises();

    for (const delay of expectedDelays) {
      harness.sockets.at(-1)?.emitClose(1013, "buffer_unavailable");
      expect(harness.schedule).toHaveBeenLastCalledWith(expect.any(Function), delay);
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(harness.schedule.mock.calls.map(([, delay]) => delay)).toEqual(expectedDelays);
  });

  it("resets reconnect backoff after a socket opens", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET, THIRD_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
    harness.sockets[0].emitClose(1013, "buffer_unavailable");
    await vi.advanceTimersByTimeAsync(3_000);
    harness.sockets[1].open();
    harness.sockets[1].emitClose();

    expect(harness.schedule).toHaveBeenLastCalledWith(expect.any(Function), 3_000);
  });

  it.each([
    new TfApiError(401, "unauthorized", "unauthenticated"),
    new TfApiError(403, "module_access_denied", "forbidden"),
    new TfApiError(503, "policy_unavailable", "unavailable"),
  ])("does not reconnect after terminal ticket error $kind", async (error) => {
    const harness = createHarness();
    harness.createTicket.mockReset();
    harness.createTicket.mockRejectedValueOnce(error);

    harness.lifecycle.start();
    await flushPromises();
    await vi.runAllTimersAsync();

    expect(harness.onTerminalError).toHaveBeenCalledOnce();
    expect(harness.onTerminalError).toHaveBeenCalledWith(error);
    expect(harness.schedule).not.toHaveBeenCalled();
    expect(harness.createTicket).toHaveBeenCalledOnce();
  });

  it.each([
    [4403, "policy_revoked", 403, "forbidden"],
    [1013, "policy_unavailable", 503, "unavailable"],
  ])(
    "treats close %s/%s as terminal %s",
    async (code, reason, status, kind) => {
      const harness = createHarness([FIRST_TICKET, SECOND_TICKET]);

      harness.lifecycle.start();
      await flushPromises();
      const socket = harness.sockets[0];
      const staleClose = socket.onclose;
      socket.open();
      socket.emitClose(code, reason);
      staleClose?.call(
        socket as unknown as WebSocket,
        new CloseEvent("close", { code, reason }),
      );
      await vi.runAllTimersAsync();

      expect(harness.onTerminalError).toHaveBeenCalledOnce();
      expect(harness.onTerminalError).toHaveBeenCalledWith(expect.objectContaining({
        status,
        code: reason,
        kind,
      }));
      expect(harness.schedule).not.toHaveBeenCalled();
      expect(harness.createTicket).toHaveBeenCalledOnce();
      expect(socket.onopen).toBeNull();
      expect(socket.onmessage).toBeNull();
      expect(socket.onerror).toBeNull();
      expect(socket.onclose).toBeNull();
    },
  );

  it("keeps 1013/buffer_unavailable transient and reconnectable", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
    harness.sockets[0].open();
    harness.sockets[0].emitClose(1013, "buffer_unavailable");

    expect(harness.onTerminalError).not.toHaveBeenCalled();
    expect(harness.schedule).toHaveBeenCalledWith(expect.any(Function), 3_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.createTicket).toHaveBeenCalledTimes(2);
    expect(harness.sockets).toHaveLength(2);
  });

  it("terminates once when an abnormal close happens before open", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
    const socket = harness.sockets[0];
    const staleClose = socket.onclose;
    socket.emitClose(1006);
    staleClose?.call(
      socket as unknown as WebSocket,
      new CloseEvent("close", { code: 1006 }),
    );
    await vi.runAllTimersAsync();

    expect(harness.onTerminalError).toHaveBeenCalledOnce();
    expect(harness.onTerminalError).toHaveBeenCalledWith(expect.objectContaining({
      status: 503,
      code: "websocket_unavailable",
      kind: "unavailable",
    }));
    expect(harness.schedule).not.toHaveBeenCalled();
    expect(harness.createTicket).toHaveBeenCalledOnce();
  });

  it("ignores pending ticket work after stop", async () => {
    const pendingTicket = deferred<string>();
    const harness = createHarness();
    harness.createTicket.mockReset();
    harness.createTicket.mockReturnValueOnce(pendingTicket.promise);

    harness.lifecycle.start();
    harness.lifecycle.stop();
    pendingTicket.resolve(FIRST_TICKET);
    await flushPromises();

    expect(harness.createSocket).not.toHaveBeenCalled();
    expect(harness.schedule).not.toHaveBeenCalled();
  });

  it("ignores a delayed terminal ticket rejection after stop", async () => {
    const pendingTicket = deferred<string>();
    const harness = createHarness();
    harness.createTicket.mockReset();
    harness.createTicket.mockReturnValueOnce(pendingTicket.promise);

    harness.lifecycle.start();
    harness.lifecycle.stop();
    pendingTicket.reject(new TfApiError(401, "unauthorized", "unauthenticated"));
    await flushPromises();

    expect(harness.onTerminalError).not.toHaveBeenCalled();
    expect(harness.schedule).not.toHaveBeenCalled();
    expect(harness.createSocket).not.toHaveBeenCalled();
  });

  it("ignores an old generation rejection without stopping the replacement", async () => {
    const oldTicket = deferred<string>();
    const harness = createHarness();
    harness.createTicket.mockReset();
    harness.createTicket
      .mockReturnValueOnce(oldTicket.promise)
      .mockResolvedValueOnce(SECOND_TICKET)
      .mockResolvedValueOnce(THIRD_TICKET);

    harness.lifecycle.start();
    harness.lifecycle.stop();
    harness.lifecycle.start();
    await flushPromises();
    const replacementSocket = harness.sockets[0];

    oldTicket.reject(new TfApiError(403, "module_access_denied", "forbidden"));
    await flushPromises();

    expect(harness.onTerminalError).not.toHaveBeenCalled();
    expect(harness.schedule).not.toHaveBeenCalled();
    expect(harness.sockets).toHaveLength(1);

    replacementSocket.open();
    replacementSocket.emitClose();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.createTicket).toHaveBeenCalledTimes(3);
    expect(harness.sockets).toHaveLength(2);
  });

  it("ignores duplicate close from a socket replaced by a new connection", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET, THIRD_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
    const firstSocket = harness.sockets[0];
    firstSocket.open();
    firstSocket.emitClose();
    await vi.advanceTimersByTimeAsync(3_000);
    const replacementSocket = harness.sockets[1];
    replacementSocket.open();

    firstSocket.emitClose();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.schedule).toHaveBeenCalledTimes(1);
    expect(harness.createTicket).toHaveBeenCalledTimes(2);
    expect(harness.sockets).toHaveLength(2);

    replacementSocket.emitClose();
    expect(harness.schedule).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(harness.createTicket).toHaveBeenCalledTimes(3);
    expect(harness.sockets).toHaveLength(3);
  });

  it("cancels reconnect timers after stop", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
    harness.sockets[0].open();
    harness.sockets[0].emitClose();
    harness.lifecycle.stop();
    await vi.runAllTimersAsync();

    expect(harness.cancelSchedule).toHaveBeenCalledOnce();
    expect(harness.createTicket).toHaveBeenCalledOnce();
  });

  it("detaches and closes the active socket after stop", async () => {
    const harness = createHarness();

    harness.lifecycle.start();
    await flushPromises();
    const socket = harness.sockets[0];
    harness.lifecycle.stop();

    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("ignores captured handlers from a stopped generation after restart", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
    const staleSocket = harness.sockets[0];
    const staleHandlers = {
      open: staleSocket.onopen,
      message: staleSocket.onmessage,
      error: staleSocket.onerror,
      close: staleSocket.onclose,
    };

    harness.lifecycle.stop();
    harness.lifecycle.start();
    await flushPromises();
    const replacementSocket = harness.sockets[1];

    staleHandlers.open?.call(staleSocket as unknown as WebSocket, new Event("open"));
    staleHandlers.message?.call(
      staleSocket as unknown as WebSocket,
      new MessageEvent("message", { data: "stale" }),
    );
    staleHandlers.error?.call(staleSocket as unknown as WebSocket, new Event("error"));
    staleHandlers.close?.call(
      staleSocket as unknown as WebSocket,
      new CloseEvent("close", { code: 4403, reason: "policy_revoked" }),
    );
    await vi.runAllTimersAsync();

    expect(harness.onMessage).not.toHaveBeenCalled();
    expect(staleSocket.close).toHaveBeenCalledOnce();
    expect(harness.schedule).not.toHaveBeenCalled();
    expect(harness.createTicket).toHaveBeenCalledTimes(2);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.onTerminalError).not.toHaveBeenCalled();
    expect(replacementSocket.readyState).toBe(WebSocket.CONNECTING);
  });

  it("detaches replaced handlers and stale callbacks cannot act or reset backoff", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET, THIRD_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
    const staleSocket = harness.sockets[0];
    const staleHandlers = {
      open: staleSocket.onopen,
      message: staleSocket.onmessage,
      error: staleSocket.onerror,
      close: staleSocket.onclose,
    };
    staleSocket.emitClose(1013, "buffer_unavailable");

    expect(staleSocket.onopen).toBeNull();
    expect(staleSocket.onmessage).toBeNull();
    expect(staleSocket.onerror).toBeNull();
    expect(staleSocket.onclose).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    const replacementSocket = harness.sockets[1];

    staleHandlers.open?.call(staleSocket as unknown as WebSocket, new Event("open"));
    staleHandlers.message?.call(
      staleSocket as unknown as WebSocket,
      new MessageEvent("message", { data: "stale" }),
    );
    staleHandlers.error?.call(staleSocket as unknown as WebSocket, new Event("error"));
    staleHandlers.close?.call(
      staleSocket as unknown as WebSocket,
      new CloseEvent("close", { code: 4403, reason: "policy_revoked" }),
    );

    expect(harness.onMessage).not.toHaveBeenCalled();
    expect(staleSocket.close).not.toHaveBeenCalled();
    expect(harness.schedule).toHaveBeenCalledTimes(1);
    expect(harness.createTicket).toHaveBeenCalledTimes(2);
    expect(harness.onTerminalError).not.toHaveBeenCalled();

    replacementSocket.emitClose(1013, "buffer_unavailable");
    expect(harness.schedule).toHaveBeenLastCalledWith(expect.any(Function), 6_000);
  });

  it("starts only one connection attempt while already running", async () => {
    const harness = createHarness();

    harness.lifecycle.start();
    harness.lifecycle.start();
    await flushPromises();

    expect(harness.createTicket).toHaveBeenCalledOnce();
    expect(harness.createSocket).toHaveBeenCalledOnce();
  });
});
