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

  emitClose(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.call(this as unknown as WebSocket, new CloseEvent("close"));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    harness.sockets[0].emitClose();

    await vi.advanceTimersByTimeAsync(3_000);
    harness.sockets[1].emitClose();
    await vi.advanceTimersByTimeAsync(6_000);

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
      harness.sockets.at(-1)?.emitClose();
      expect(harness.schedule).toHaveBeenLastCalledWith(expect.any(Function), delay);
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(harness.schedule.mock.calls.map(([, delay]) => delay)).toEqual(expectedDelays);
  });

  it("resets reconnect backoff after a socket opens", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET, THIRD_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
    harness.sockets[0].emitClose();
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

  it("cancels reconnect timers after stop", async () => {
    const harness = createHarness([FIRST_TICKET, SECOND_TICKET]);

    harness.lifecycle.start();
    await flushPromises();
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

    expect(socket.onclose).toBeNull();
    expect(socket.close).toHaveBeenCalledOnce();
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
