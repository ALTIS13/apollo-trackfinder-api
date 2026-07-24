import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import { Writable } from "node:stream";

import type { PolicyIntrospectionResponse } from "@workspace/platform-contract";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTfLogger } from "./lib/logger.js";
import {
  TfSessionStoreUnavailableError,
  type TfSession,
  type WebSocketTicket,
} from "./lib/tf-session-store.js";
import * as serverStartup from "./lib/server-startup.js";
import {
  attachWebSocketServer,
  canBufferWebSocketMessage,
  type WebSocketServerHandle,
  type WebSocketTimerScheduler,
} from "./ws.js";

const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "90000000-0000-4000-8000-000000000009";
const PLATFORM_SESSION_ID = "20000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "30000000-0000-4000-8000-000000000003";
const REVISION = randomBytes(32).toString("base64url");
const servers: Server[] = [];
const handles: WebSocketServerHandle[] = [];
const clients: WebSocket[] = [];
const rawSockets: Socket[] = [];

function opaque(): string {
  return randomBytes(32).toString("base64url");
}

function session(
  accountId = ACCOUNT_A,
  overrides: Partial<TfSession> = {},
): TfSession {
  return {
    id: randomUUID(),
    accountId,
    platformSessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    entitlements: ["tf.search"],
    assertionExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function ticket(
  value: string,
  tfSession: TfSession,
): WebSocketTicket & { readonly value: string } {
  const now = Date.now();
  return {
    value,
    accountId: tfSession.accountId,
    sessionId: tfSession.id,
    sessionHandle: opaque(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
  };
}

function activeIntrospection(
  tfSession: TfSession,
): Extract<PolicyIntrospectionResponse, { active: true }> {
  return {
    active: true as const,
    accountId: tfSession.accountId,
    sessionId: tfSession.platformSessionId,
    installationId: tfSession.installationId,
    accountStatus: "active" as const,
    entitlements: ["tf.search"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function dependencies(initialTickets: readonly ReturnType<typeof ticket>[]) {
  const tickets = new Map(
    initialTickets.map(({ value, ...binding }) => [value, binding]),
  );
  const sessions = new Map(
    initialTickets.map(({ sessionHandle, ...rest }) => [
      sessionHandle,
      session(rest.accountId, { id: rest.sessionId }),
    ]),
  );
  const sessionStore = {
    consumeWebSocketTicket: vi.fn(async (value: string) => {
      const binding = tickets.get(value) ?? null;
      tickets.delete(value);
      return binding;
    }),
    observeSession: vi.fn(async (handle: string) => {
      const tfSession = sessions.get(handle);
      return tfSession === undefined
        ? null
        : { revision: REVISION, session: tfSession };
    }),
  };
  const platform = {
    introspect: vi.fn(async (input: { readonly accountId: string }) => {
      const tfSession = [...sessions.values()].find(
        (candidate) => candidate.accountId === input.accountId,
      );
      if (tfSession === undefined) return { active: false as const };
      return activeIntrospection(tfSession);
    }),
  };
  return { sessionStore, platform, sessions };
}

class ManualScheduler implements WebSocketTimerScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();

  setInterval(callback: () => void, milliseconds: number): number {
    expect(milliseconds).toBe(30_000);
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runAll(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }

  get size(): number {
    return this.callbacks.size;
  }
}

async function startWs(
  currentDependencies: ReturnType<typeof dependencies>,
  options: {
    readonly scheduler?: WebSocketTimerScheduler;
    readonly logger?: ReturnType<typeof createTfLogger>;
  } = {},
): Promise<{
  readonly origin: string;
  readonly handle: WebSocketServerHandle;
  readonly server: Server;
}> {
  const server = createServer((_incoming, response) => {
    response.writeHead(404).end();
  });
  servers.push(server);
  const handle = attachWebSocketServer(server, {
    platform: currentDependencies.platform,
    sessionStore: currentDependencies.sessionStore,
    scheduler: options.scheduler,
    logger: options.logger,
  });
  if (handle !== undefined) handles.push(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { origin: `ws://127.0.0.1:${address.port}`, handle, server };
}

async function connect(
  url: string,
): Promise<{ readonly statusCode: number; readonly ws?: WebSocket }> {
  const ws = new WebSocket(url);
  clients.push(ws);
  return new Promise((resolve) => {
    let settled = false;
    ws.once("open", () => {
      settled = true;
      resolve({ statusCode: 101, ws });
    });
    ws.once("unexpected-response", (_upgradeRequest, response) => {
      settled = true;
      response.resume();
      resolve({ statusCode: response.statusCode ?? 0 });
    });
    ws.once("error", () => {
      if (!settled) {
        settled = true;
        resolve({ statusCode: 0 });
      }
    });
  });
}

async function connectOpen(url: string): Promise<WebSocket> {
  const result = await connect(url);
  expect(result.statusCode).toBe(101);
  expect(result.ws).toBeDefined();
  return result.ws!;
}

async function rawUpgrade(
  origin: string,
  path: string,
  headerOverrides: Readonly<Record<string, string>> = {},
): Promise<number> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const upgradeRequest = request({
      hostname: url.hostname,
      port: url.port,
      path,
      setHost: false,
      headers: {
        Host: `${url.hostname}:${url.port}`,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...headerOverrides,
      },
    });
    upgradeRequest.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    upgradeRequest.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    upgradeRequest.once("error", () => resolve(0));
    upgradeRequest.end();
  });
}

async function rawUpgradeResponse(
  origin: string,
  path: string,
): Promise<{
  readonly status: number;
  readonly connection: string | undefined;
  readonly body: string;
}> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const upgradeRequest = request({
      hostname: url.hostname,
      port: url.port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    upgradeRequest.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          connection: response.headers.connection,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    upgradeRequest.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("unexpected upgrade"));
    });
    upgradeRequest.once("error", reject);
    upgradeRequest.end();
  });
}

interface RawWebSocketPeer {
  readonly socket: Socket;
  sendText(payload: string): void;
  waitForCloseCode(milliseconds?: number): Promise<number>;
}

function maskedTextFrame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  if (body.byteLength > 125) throw new Error("raw test payload too large");
  const mask = randomBytes(4);
  const frame = Buffer.allocUnsafe(2 + mask.byteLength + body.byteLength);
  frame[0] = 0x81;
  frame[1] = 0x80 | body.byteLength;
  mask.copy(frame, 2);
  for (let index = 0; index < body.byteLength; index += 1) {
    frame[6 + index] = body[index]! ^ mask[index % mask.byteLength]!;
  }
  return frame;
}

async function connectRawWebSocket(
  origin: string,
  path: string,
): Promise<RawWebSocketPeer> {
  const url = new URL(origin);
  const socket = createConnection({
    host: url.hostname,
    port: Number(url.port),
  });
  rawSockets.push(socket);
  let buffered = Buffer.alloc(0);
  let notifyData: (() => void) | null = null;
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    notifyData?.();
    notifyData = null;
  });
  await once(socket, "connect");
  socket.write(
    `GET ${path} HTTP/1.1\r\n` +
      `Host: ${url.hostname}:${url.port}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n",
  );

  const waitForData = async (deadline: number): Promise<void> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("raw WebSocket timeout");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        notifyData = null;
        reject(new Error("raw WebSocket timeout"));
      }, remaining);
      notifyData = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  };

  const handshakeDeadline = Date.now() + 1_000;
  while (buffered.indexOf("\r\n\r\n") < 0) {
    await waitForData(handshakeDeadline);
  }
  const headerEnd = buffered.indexOf("\r\n\r\n") + 4;
  const response = buffered.subarray(0, headerEnd).toString("latin1");
  buffered = buffered.subarray(headerEnd);
  if (!response.startsWith("HTTP/1.1 101 ")) {
    throw new Error("raw WebSocket upgrade rejected");
  }

  return {
    socket,
    sendText: (payload) => socket.write(maskedTextFrame(payload)),
    waitForCloseCode: async (milliseconds = 1_000) => {
      const deadline = Date.now() + milliseconds;
      while (true) {
        if (buffered.byteLength >= 2) {
          const payloadLength = buffered[1]! & 0x7f;
          if (payloadLength >= 126) {
            throw new Error("unexpected raw WebSocket frame length");
          }
          const frameLength = 2 + payloadLength;
          if (buffered.byteLength >= frameLength) {
            const opcode = buffered[0]! & 0x0f;
            const payload = buffered.subarray(2, frameLength);
            buffered = buffered.subarray(frameLength);
            if (opcode === 0x8 && payload.byteLength >= 2) {
              return payload.readUInt16BE(0);
            }
          }
        }
        await waitForData(deadline);
      }
    },
  };
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve(code));
  });
}

async function expectNoMessageDuring(
  ws: WebSocket,
  action: () => void,
  milliseconds = 80,
): Promise<void> {
  let received = false;
  const onMessage = (): void => {
    received = true;
  };
  ws.on("message", onMessage);
  action();
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  ws.off("message", onMessage);
  expect(received).toBe(false);
}

afterEach(async () => {
  for (const socket of rawSockets.splice(0)) socket.destroy();
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("one-time WebSocket upgrades", () => {
  it("rejects legacy, duplicate, extra, malformed, fragment, and near-match URLs", async () => {
    const tfSession = session();
    const validTicket = ticket(opaque(), tfSession);
    const current = dependencies([validTicket]);
    const { origin } = await startWs(current);
    const alias = `${validTicket.value.slice(0, -1)}${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".at(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(
        validTicket.value.at(-1)!,
      ) + 1,
    )}`;

    const statuses = await Promise.all([
      rawUpgrade(origin, `/api/ws?sessionId=${opaque()}`),
      rawUpgrade(
        origin,
        `/api/ws?ticket=${validTicket.value}&ticket=${validTicket.value}`,
      ),
      rawUpgrade(origin, `/api/ws?ticket=${validTicket.value}&extra=1`),
      rawUpgrade(origin, `/api/ws?ticket=${alias}`),
      rawUpgrade(origin, `/api/ws?ticket=${validTicket.value}#fragment`),
      rawUpgrade(origin, `/api/ws/extra?ticket=${validTicket.value}`),
      rawUpgrade(origin, `ws://127.0.0.1/api/ws?ticket=${validTicket.value}`),
      rawUpgrade(origin, `/api/./ws?ticket=${validTicket.value}`),
      rawUpgrade(origin, `/api/%77s?ticket=${validTicket.value}`),
      rawUpgrade(origin, `/api/ws?Ticket=${validTicket.value}`),
    ]);

    expect(statuses).toEqual([
      401, 401, 401, 401, 401, 404, 404, 404, 404, 401,
    ]);
    expect(current.sessionStore.consumeWebSocketTicket).not.toHaveBeenCalled();
  });

  it("rejects a malformed WebSocket handshake before consuming the ticket", async () => {
    const tfSession = session();
    const oneTime = ticket(opaque(), tfSession);
    const current = dependencies([oneTime]);
    const { origin } = await startWs(current);

    await expect(
      rawUpgrade(origin, `/api/ws?ticket=${oneTime.value}`, {
        "Sec-WebSocket-Key": "not-canonical-base64",
      }),
    ).resolves.toBe(401);
    expect(current.sessionStore.consumeWebSocketTicket).not.toHaveBeenCalled();

    await expect(
      rawUpgrade(origin, `/api/ws?ticket=${oneTime.value}`, {
        "Sec-WebSocket-Protocol": "invalid protocol",
      }),
    ).resolves.toBe(401);
    expect(current.sessionStore.consumeWebSocketTicket).not.toHaveBeenCalled();

    await expect(
      rawUpgrade(origin, `/api/ws?ticket=${oneTime.value}`, {
        Host: "",
      }),
    ).resolves.toBe(401);
    expect(current.sessionStore.consumeWebSocketTicket).not.toHaveBeenCalled();

    await expect(
      rawUpgrade(origin, `/api/ws?ticket=${oneTime.value}`),
    ).resolves.toBe(101);
    expect(current.sessionStore.consumeWebSocketTicket).toHaveBeenCalledOnce();
  });

  it("accepts exactly one of concurrent upgrades and rejects replay", async () => {
    const tfSession = session();
    const oneTime = ticket(opaque(), tfSession);
    const current = dependencies([oneTime]);
    const { origin } = await startWs(current);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        connect(`${origin}/api/ws?ticket=${oneTime.value}`),
      ),
    );

    expect(results.filter((result) => result.statusCode === 101)).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.statusCode === 401)).toHaveLength(
      7,
    );
    await expect(
      rawUpgrade(origin, `/api/ws?ticket=${oneTime.value}`),
    ).resolves.toBe(401);
  });

  it("re-observes the exact revision after introspection and blocks revoke TOCTOU", async () => {
    const tfSession = session();
    const oneTime = ticket(opaque(), tfSession);
    const current = dependencies([oneTime]);
    const observed = {
      revision: REVISION,
      session: current.sessions.get(oneTime.sessionHandle)!,
    };
    current.sessionStore.observeSession
      .mockResolvedValueOnce(observed)
      .mockResolvedValueOnce(null);
    const { origin } = await startWs(current);

    await expect(
      rawUpgrade(origin, `/api/ws?ticket=${oneTime.value}`),
    ).resolves.toBe(401);
    expect(current.platform.introspect).toHaveBeenCalledOnce();
    expect(current.sessionStore.observeSession).toHaveBeenCalledTimes(2);
  });

  it("accepts a concurrent HTTP policy refresh during WebSocket validation", async () => {
    const tfSession = session();
    const oneTime = ticket(opaque(), tfSession);
    const current = dependencies([oneTime]);
    const observed = {
      revision: REVISION,
      session: current.sessions.get(oneTime.sessionHandle)!,
    };
    current.sessionStore.observeSession
      .mockResolvedValueOnce(observed)
      .mockResolvedValueOnce({
        revision: opaque(),
        session: observed.session,
      });
    const { origin } = await startWs(current);

    await expect(
      rawUpgrade(origin, `/api/ws?ticket=${oneTime.value}`),
    ).resolves.toBe(101);
  });

  it("maps a changed post-introspection immutable binding to 503", async () => {
    const tfSession = session();
    const oneTime = ticket(opaque(), tfSession);
    const current = dependencies([oneTime]);
    const observed = {
      revision: REVISION,
      session: current.sessions.get(oneTime.sessionHandle)!,
    };
    current.sessionStore.observeSession
      .mockResolvedValueOnce(observed)
      .mockResolvedValueOnce({
        revision: opaque(),
        session: {
          ...observed.session,
          installationId: "90000000-0000-4000-8000-000000000009",
        },
      });
    const { origin } = await startWs(current);

    await expect(
      rawUpgrade(origin, `/api/ws?ticket=${oneTime.value}`),
    ).resolves.toBe(503);
  });

  it("returns 503 when ticket storage is unavailable", async () => {
    const current = dependencies([]);
    current.sessionStore.consumeWebSocketTicket.mockRejectedValue(
      new TfSessionStoreUnavailableError(),
    );
    const { origin } = await startWs(current);

    await expect(
      rawUpgrade(origin, `/api/ws?ticket=${opaque()}`),
    ).resolves.toBe(503);
  });

  it("returns empty generic 401 and 503 upgrade responses with Connection close", async () => {
    const current = dependencies([]);
    const { origin } = await startWs(current);
    const missing = await rawUpgradeResponse(
      origin,
      `/api/ws?ticket=${opaque()}`,
    );
    current.sessionStore.consumeWebSocketTicket.mockRejectedValue(
      new TfSessionStoreUnavailableError(),
    );
    const unavailable = await rawUpgradeResponse(
      origin,
      `/api/ws?ticket=${opaque()}`,
    );

    expect(missing).toEqual({
      status: 401,
      connection: "close",
      body: "",
    });
    expect(unavailable).toEqual({
      status: 503,
      connection: "close",
      body: "",
    });
  });

  it.each([
    ["inactive", { active: false as const }, 401],
    [
      "wrong binding",
      {
        active: true as const,
        accountId: ACCOUNT_B,
        sessionId: PLATFORM_SESSION_ID,
        installationId: INSTALLATION_ID,
        accountStatus: "active" as const,
        entitlements: ["tf.search"] as const,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      503,
    ],
    [
      "expired",
      {
        active: true as const,
        accountId: ACCOUNT_A,
        sessionId: PLATFORM_SESSION_ID,
        installationId: INSTALLATION_ID,
        accountStatus: "active" as const,
        entitlements: ["tf.search"] as const,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      401,
    ],
    [
      "missing entitlement",
      {
        active: true as const,
        accountId: ACCOUNT_A,
        sessionId: PLATFORM_SESSION_ID,
        installationId: INSTALLATION_ID,
        accountStatus: "active" as const,
        entitlements: [] as const,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      401,
    ],
  ])(
    "rejects %s live introspection before 101",
    async (_name, result, status) => {
      const tfSession = session();
      const oneTime = ticket(opaque(), tfSession);
      const current = dependencies([oneTime]);
      current.platform.introspect.mockResolvedValue(
        result as PolicyIntrospectionResponse,
      );
      const { origin } = await startWs(current);

      await expect(
        rawUpgrade(origin, `/api/ws?ticket=${oneTime.value}`),
      ).resolves.toBe(status);
    },
  );
});

describe("connected WebSocket lifecycle", () => {
  it("relays bounded player state only within the account room", async () => {
    const firstSession = session(ACCOUNT_A);
    const secondSession = session(ACCOUNT_A);
    const otherSession = session(ACCOUNT_B);
    const firstTicket = ticket(opaque(), firstSession);
    const secondTicket = ticket(opaque(), secondSession);
    const otherTicket = ticket(opaque(), otherSession);
    const current = dependencies([firstTicket, secondTicket, otherTicket]);
    const { origin } = await startWs(current);
    const first = await connectOpen(
      `${origin}/api/ws?ticket=${firstTicket.value}`,
    );
    const second = await connectOpen(
      `${origin}/api/ws?ticket=${secondTicket.value}`,
    );
    const other = await connectOpen(
      `${origin}/api/ws?ticket=${otherTicket.value}`,
    );
    const valid = {
      type: "player_state",
      track: {
        id: "track-1",
        title: "Track",
        artist: "Artist",
        thumbnailUrl: null,
        duration: 180,
        source: "soundcloud",
      },
      position: 12.5,
      isPlaying: true,
    };
    const message = once(second, "message");
    const isolated = expectNoMessageDuring(other, () => {
      first.send(JSON.stringify(valid));
    });

    const [payload] = await message;
    expect(JSON.parse(payload.toString())).toEqual(valid);
    await isolated;

    await expectNoMessageDuring(second, () => {
      first.send(JSON.stringify({ ...valid, extra: true }));
    });
    await expectNoMessageDuring(second, () => {
      first.send(Buffer.from([0xc3, 0x28]), { binary: false });
    });
    await expectNoMessageDuring(second, () => {
      first.send(JSON.stringify({ ...valid, position: -1 }));
    });
    await expectNoMessageDuring(second, () => {
      first.send(JSON.stringify(valid), { binary: true });
    });
    await expectNoMessageDuring(second, () => {
      first.send("x".repeat(20 * 1024));
    });
  });

  it("keeps rooms local to each attached server instance", async () => {
    const firstSession = session();
    const secondSession = session();
    const firstTicket = ticket(opaque(), firstSession);
    const secondTicket = ticket(opaque(), secondSession);
    const firstServer = await startWs(dependencies([firstTicket]));
    const secondServer = await startWs(dependencies([secondTicket]));
    const sender = await connectOpen(
      `${firstServer.origin}/api/ws?ticket=${firstTicket.value}`,
    );
    const isolated = await connectOpen(
      `${secondServer.origin}/api/ws?ticket=${secondTicket.value}`,
    );

    await expectNoMessageDuring(isolated, () => {
      sender.send(
        JSON.stringify({
          type: "player_state",
          track: null,
          position: 0,
          isPlaying: false,
        }),
      );
    });
  });

  it("bounds queued outbound bytes before relaying", () => {
    expect(canBufferWebSocketMessage(0, 16 * 1024)).toBe(true);
    expect(canBufferWebSocketMessage(256 * 1024 - 1, 1)).toBe(true);
    expect(canBufferWebSocketMessage(256 * 1024, 1)).toBe(false);
    expect(canBufferWebSocketMessage(Number.MAX_SAFE_INTEGER, 1)).toBe(false);
  });

  it.each([
    ["revocation", { active: false as const }, 4403],
    [
      "missing entitlement",
      {
        active: true as const,
        accountId: ACCOUNT_A,
        sessionId: PLATFORM_SESSION_ID,
        installationId: INSTALLATION_ID,
        accountStatus: "active" as const,
        entitlements: [] as const,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      4403,
    ],
    [
      "expired policy",
      {
        active: true as const,
        accountId: ACCOUNT_A,
        sessionId: PLATFORM_SESSION_ID,
        installationId: INSTALLATION_ID,
        accountStatus: "active" as const,
        entitlements: ["tf.search"] as const,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      4403,
    ],
    [
      "inconsistent binding",
      {
        active: true as const,
        accountId: ACCOUNT_B,
        sessionId: PLATFORM_SESSION_ID,
        installationId: INSTALLATION_ID,
        accountStatus: "active" as const,
        entitlements: ["tf.search"] as const,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      1013,
    ],
    ["outage", new TfSessionStoreUnavailableError(), 1013],
  ])("closes with the required code after %s", async (_name, result, code) => {
    const tfSession = session();
    const oneTime = ticket(opaque(), tfSession);
    const current = dependencies([oneTime]);
    const scheduler = new ManualScheduler();
    const { origin } = await startWs(current, { scheduler });
    const ws = await connectOpen(`${origin}/api/ws?ticket=${oneTime.value}`);
    const closed = closeCode(ws);
    if (result instanceof Error) {
      current.sessionStore.observeSession.mockRejectedValue(result);
    } else {
      current.platform.introspect.mockResolvedValue(
        result as PolicyIntrospectionResponse,
      );
    }

    scheduler.runAll();

    await expect(closed).resolves.toBe(code);
    expect(scheduler.size).toBe(0);
  });

  it.each([
    ["forbidden", 4403],
    ["unavailable", 1013],
  ])(
    "does not relay a raw peer after periodic policy becomes %s",
    async (outcome, expectedCloseCode) => {
      const senderSession = session(ACCOUNT_A);
      const recipientSession = session(ACCOUNT_A);
      const senderTicket = ticket(opaque(), senderSession);
      const recipientTicket = ticket(opaque(), recipientSession);
      const current = dependencies([senderTicket, recipientTicket]);
      const scheduler = new ManualScheduler();
      const { origin } = await startWs(current, { scheduler });
      const sender = await connectRawWebSocket(
        origin,
        `/api/ws?ticket=${senderTicket.value}`,
      );
      const recipient = await connectOpen(
        `${origin}/api/ws?ticket=${recipientTicket.value}`,
      );
      const originalObserve =
        current.sessionStore.observeSession.getMockImplementation()!;
      if (outcome === "forbidden") {
        current.sessions.delete(senderTicket.sessionHandle);
      } else {
        current.sessionStore.observeSession.mockImplementation(
          async (handle: string) => {
            if (handle === senderTicket.sessionHandle) {
              throw new TfSessionStoreUnavailableError();
            }
            return originalObserve(handle);
          },
        );
      }

      const serverClose = sender.waitForCloseCode();
      scheduler.runAll();
      await expect(serverClose).resolves.toBe(expectedCloseCode);
      expect(recipient.readyState).toBe(WebSocket.OPEN);

      await expectNoMessageDuring(
        recipient,
        () =>
          sender.sendText(
            JSON.stringify({
              type: "player_state",
              track: null,
              position: 0,
              isPlaying: false,
            }),
          ),
        150,
      );
      expect(recipient.readyState).toBe(WebSocket.OPEN);
    },
  );

  it("closes only sockets backed by the revoked TF session", async () => {
    const revokedSession = session(ACCOUNT_A);
    const healthySession = session(ACCOUNT_A);
    const revokedTicket = ticket(opaque(), revokedSession);
    const healthyTicket = ticket(opaque(), healthySession);
    const current = dependencies([revokedTicket, healthyTicket]);
    const scheduler = new ManualScheduler();
    const { origin } = await startWs(current, { scheduler });
    const revokedSocket = await connectOpen(
      `${origin}/api/ws?ticket=${revokedTicket.value}`,
    );
    const healthySocket = await connectOpen(
      `${origin}/api/ws?ticket=${healthyTicket.value}`,
    );
    const revokedClose = closeCode(revokedSocket);
    current.sessions.delete(revokedTicket.sessionHandle);

    scheduler.runAll();

    await expect(revokedClose).resolves.toBe(4403);
    expect(healthySocket.readyState).toBe(WebSocket.OPEN);
    expect(scheduler.size).toBe(1);
  });

  it("removes timers/listeners and never logs ticket or session canaries", async () => {
    const ticketCanary = opaque();
    const tfSession = session();
    const oneTime = ticket(ticketCanary, tfSession);
    const current = dependencies([oneTime]);
    const sessionCanary = oneTime.sessionHandle;
    const scheduler = new ManualScheduler();
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createTfLogger(destination);
    const { origin, handle } = await startWs(current, { scheduler, logger });
    const ws = await connectOpen(`${origin}/api/ws?ticket=${ticketCanary}`);
    ws.close();
    await once(ws, "close");

    await handle.close();

    expect(scheduler.size).toBe(0);
    expect(output).not.toContain(ticketCanary);
    expect(output).not.toContain(sessionCanary);
    expect(output).not.toContain(tfSession.platformSessionId);
  });

  it("idempotently closes active and pending sockets before detaching", async () => {
    const tfSession = session();
    const activeTicket = ticket(opaque(), tfSession);
    const pendingTicket = ticket(opaque(), session());
    const current = dependencies([activeTicket, pendingTicket]);
    let releasePending: (() => void) | undefined;
    const pending = new Promise<WebSocketTicket | null>((resolve) => {
      releasePending = () => resolve(null);
    });
    const originalConsume =
      current.sessionStore.consumeWebSocketTicket.getMockImplementation()!;
    current.sessionStore.consumeWebSocketTicket.mockImplementation(
      async (value: string) =>
        value === pendingTicket.value ? pending : originalConsume(value),
    );
    const scheduler = new ManualScheduler();
    const { origin, handle, server } = await startWs(current, { scheduler });
    const active = await connectOpen(
      `${origin}/api/ws?ticket=${activeTicket.value}`,
    );
    const activeClosed = closeCode(active);
    const pendingUpgrade = rawUpgrade(
      origin,
      `/api/ws?ticket=${pendingTicket.value}`,
    );
    await vi.waitFor(() => {
      expect(current.sessionStore.consumeWebSocketTicket).toHaveBeenCalledWith(
        pendingTicket.value,
      );
    });

    const firstClose = handle.close();
    expect(handle.close()).toBe(firstClose);
    await firstClose;
    releasePending?.();

    await expect(activeClosed).resolves.toBeGreaterThanOrEqual(1000);
    await expect(pendingUpgrade).resolves.toBe(0);
    expect(server.listenerCount("upgrade")).toBe(0);
    expect(scheduler.size).toBe(0);
  });
});

describe("API startup WebSocket orchestration", () => {
  it("closes attached WebSockets before startup resource cleanup", async () => {
    type InitializeApiRuntime = (
      server: Server,
      options: {
        readonly attachWebSocket: (server: Server) => WebSocketServerHandle;
        readonly initializeAfterAttach: () => Promise<void>;
      },
    ) => Promise<WebSocketServerHandle>;
    const initializeApiRuntime = Reflect.get(
      serverStartup,
      "initializeApiRuntime",
    ) as InitializeApiRuntime | undefined;
    const activeSession = session();
    const pendingSession = session();
    const activeTicket = ticket(opaque(), activeSession);
    const pendingTicket = ticket(opaque(), pendingSession);
    const current = dependencies([activeTicket, pendingTicket]);
    const scheduler = new ManualScheduler();
    const originalConsume =
      current.sessionStore.consumeWebSocketTicket.getMockImplementation()!;
    let markPendingStarted: (() => void) | undefined;
    const pendingStarted = new Promise<void>((resolve) => {
      markPendingStarted = resolve;
    });
    current.sessionStore.consumeWebSocketTicket.mockImplementation(
      async (value: string) => {
        if (value === pendingTicket.value) {
          markPendingStarted?.();
          return new Promise<WebSocketTicket | null>(() => {});
        }
        return originalConsume(value);
      },
    );
    const serverSockets = new Set<Socket>();
    const closeQueues = vi.fn(async () => {});
    let cleanupSnapshot:
      | {
          readonly activeReadyState: number;
          readonly allServerSocketsDestroyed: boolean;
          readonly serverSocketCount: number;
          readonly timerCount: number;
          readonly upgradeListenerCount: number;
        }
      | undefined;
    let activeClient: WebSocket | undefined;
    let pendingUpgrade: Promise<number> | undefined;
    let attachCalled = false;
    let initializeAfterAttachCalled = false;
    let listeningServer: Server | undefined;
    const closeRedis = vi.fn(async () => {
      cleanupSnapshot = {
        activeReadyState: activeClient?.readyState ?? WebSocket.CLOSED,
        allServerSocketsDestroyed: [...serverSockets].every(
          (socket) => socket.destroyed,
        ),
        serverSocketCount: serverSockets.size,
        timerCount: scheduler.size,
        upgradeListenerCount: listeningServer?.listenerCount("upgrade") ?? -1,
      };
    });

    await expect(
      serverStartup.startApiListener({
        listen: () => {
          const server = createServer((_request, response) => {
            response.writeHead(404).end();
          });
          listeningServer = server;
          servers.push(server);
          server.on("connection", (socket) => serverSockets.add(socket));
          server.listen(0, "127.0.0.1");
          return server;
        },
        initialize: async (server) => {
          if (initializeApiRuntime === undefined) {
            throw new Error("missing API runtime initializer");
          }
          await initializeApiRuntime(server, {
            attachWebSocket: (attachedServer) => {
              attachCalled = true;
              const handle = attachWebSocketServer(attachedServer, {
                platform: current.platform,
                sessionStore: current.sessionStore,
                scheduler,
              });
              handles.push(handle);
              return handle;
            },
            initializeAfterAttach: async () => {
              initializeAfterAttachCalled = true;
              const address = server.address() as AddressInfo;
              const origin = `ws://127.0.0.1:${address.port}`;
              activeClient = await connectOpen(
                `${origin}/api/ws?ticket=${activeTicket.value}`,
              );
              pendingUpgrade = rawUpgrade(
                origin,
                `/api/ws?ticket=${pendingTicket.value}`,
              );
              await pendingStarted;
              throw new Error("later initialization failed");
            },
          });
        },
        closeQueues,
        closeRedis,
      }),
    ).rejects.toThrow("TF API startup failed");

    expect(attachCalled).toBe(true);
    expect(initializeAfterAttachCalled).toBe(true);
    expect(cleanupSnapshot).toEqual({
      activeReadyState: WebSocket.CLOSED,
      allServerSocketsDestroyed: true,
      serverSocketCount: 2,
      timerCount: 0,
      upgradeListenerCount: 0,
    });
    await expect(pendingUpgrade).resolves.toBe(0);
    expect(closeQueues).toHaveBeenCalledOnce();
    expect(closeRedis).toHaveBeenCalledOnce();
  });
});
