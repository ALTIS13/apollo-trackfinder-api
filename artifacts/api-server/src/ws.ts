import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import type { PolicyIntrospectionResponse } from "@workspace/platform-contract";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";

import { logger as defaultLogger } from "./lib/logger.js";
import type { PlatformAuthClient } from "./lib/platform-auth-client.js";
import type {
  TfSession,
  TfSessionStore,
  TfSessionObservation,
  WebSocketTicket,
} from "./lib/tf-session-store.js";

const WEBSOCKET_PATH = "/api/ws";
const VALIDATION_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024;
const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COMPONENT = "tf-websocket";

const playerSyncMessageSchema = z
  .object({
    type: z.literal("player_state"),
    track: z
      .object({
        id: z.string().min(1).max(512),
        title: z.string().max(1_024),
        artist: z.string().max(1_024),
        thumbnailUrl: z.string().max(2_048).nullable(),
        duration: z.number().finite().nonnegative().max(86_400),
        source: z.string().min(1).max(128).optional(),
      })
      .strict()
      .nullable(),
    position: z.number().finite().nonnegative().max(86_400),
    isPlaying: z.boolean(),
  })
  .strict();

export interface PlayerSyncMessage extends z.infer<
  typeof playerSyncMessageSchema
> {}

export interface WebSocketTimerScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface WebSocketServerDependencies {
  readonly platform: Pick<PlatformAuthClient, "introspect">;
  readonly sessionStore: Pick<
    TfSessionStore,
    "consumeWebSocketTicket" | "observeSession"
  >;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly scheduler?: WebSocketTimerScheduler;
}

export interface WebSocketServerHandle {
  close(): Promise<void>;
}

type ValidationResult = "authorized" | "forbidden" | "unavailable";

interface SocketContext {
  readonly ticket: WebSocketTicket;
  readonly room: Set<WebSocket>;
  timer: unknown;
  authorized: boolean;
  validating: boolean;
  cleaned: boolean;
}

const defaultScheduler: WebSocketTimerScheduler = {
  setInterval: (callback, milliseconds) =>
    globalThis.setInterval(callback, milliseconds),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

function canonicalOpaque(value: string): boolean {
  if (!OPAQUE_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}

function parseUpgradeTarget(
  rawTarget: string | undefined,
):
  | { readonly kind: "valid"; readonly ticket: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "not_found" } {
  if (rawTarget === undefined || /[\u0000-\u001f\u007f]/u.test(rawTarget)) {
    return { kind: "invalid" };
  }
  const queryIndex = rawTarget.indexOf("?");
  const path = queryIndex < 0 ? rawTarget : rawTarget.slice(0, queryIndex);
  if (path !== WEBSOCKET_PATH) return { kind: "not_found" };
  if (queryIndex < 0) return { kind: "invalid" };
  const query = rawTarget.slice(queryIndex + 1);
  const match = /^ticket=([A-Za-z0-9_-]{43})$/.exec(query);
  if (match === null || !canonicalOpaque(match[1]!)) {
    return { kind: "invalid" };
  }
  return { kind: "valid", ticket: match[1]! };
}

function exactRawHeader(request: IncomingMessage, name: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values.length === 1 ? values[0]! : null;
}

function canonicalWebSocketKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 16 && bytes.toString("base64") === value;
}

function validUpgradeHandshake(request: IncomingMessage): boolean {
  if (
    request.method !== "GET" ||
    request.httpVersion !== "1.1" ||
    request.headers["content-length"] !== undefined ||
    request.headers["transfer-encoding"] !== undefined ||
    request.headers["sec-websocket-protocol"] !== undefined
  ) {
    return false;
  }
  const connection = exactRawHeader(request, "connection");
  const host = exactRawHeader(request, "host");
  const upgrade = exactRawHeader(request, "upgrade");
  const key = exactRawHeader(request, "sec-websocket-key");
  const version = exactRawHeader(request, "sec-websocket-version");
  return (
    connection !== null &&
    connection
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .includes("upgrade") &&
    host !== null &&
    /^[\x21-\x7e]{1,255}$/.test(host) &&
    upgrade?.toLowerCase() === "websocket" &&
    key !== null &&
    canonicalWebSocketKey(key) &&
    version === "13"
  );
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("invalid WebSocket clock");
  }
  return value;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function activePolicyBinding(
  ticket: WebSocketTicket,
  observation: TfSessionObservation,
  introspection: PolicyIntrospectionResponse,
  now: number,
): ValidationResult {
  const session = observation.session;
  const sessionExpiresAt = timestamp(session.expiresAt);
  if (sessionExpiresAt === null) return "unavailable";
  if (
    session.accountId !== ticket.accountId ||
    session.id !== ticket.sessionId
  ) {
    return "unavailable";
  }
  if (sessionExpiresAt <= now) return "forbidden";
  if (!introspection.active) return "forbidden";
  const policyExpiresAt = timestamp(introspection.expiresAt);
  if (policyExpiresAt === null) return "unavailable";
  if (
    introspection.accountId !== session.accountId ||
    introspection.sessionId !== session.platformSessionId ||
    introspection.installationId !== session.installationId
  ) {
    return "unavailable";
  }
  if (
    introspection.accountStatus !== "active" ||
    policyExpiresAt <= now ||
    !introspection.entitlements.includes("tf.search")
  ) {
    return "forbidden";
  }
  return "authorized";
}

async function validateBackingPolicy(
  ticket: WebSocketTicket,
  dependencies: WebSocketServerDependencies,
): Promise<ValidationResult> {
  try {
    const observation = await dependencies.sessionStore.observeSession(
      ticket.sessionHandle,
    );
    if (observation === null) return "forbidden";
    const observedAt = checkedNow(dependencies.now ?? Date.now);
    const sessionExpiresAt = timestamp(observation.session.expiresAt);
    if (sessionExpiresAt === null) return "unavailable";
    if (
      observation.session.accountId !== ticket.accountId ||
      observation.session.id !== ticket.sessionId
    ) {
      return "unavailable";
    }
    if (sessionExpiresAt <= observedAt) return "forbidden";
    const introspection = await dependencies.platform.introspect({
      accountId: observation.session.accountId,
      sessionId: observation.session.platformSessionId,
      installationId: observation.session.installationId,
      audience: "apollo-tf",
    });
    const confirmed = await dependencies.sessionStore.observeSession(
      ticket.sessionHandle,
    );
    if (confirmed === null) return "forbidden";
    if (
      confirmed.session.id !== observation.session.id ||
      confirmed.session.accountId !== observation.session.accountId ||
      confirmed.session.platformSessionId !==
        observation.session.platformSessionId ||
      confirmed.session.installationId !== observation.session.installationId
    ) {
      return "unavailable";
    }
    if (confirmed.revision !== observation.revision) {
      const concurrentPolicyExpiry = timestamp(
        confirmed.session.assertionExpiresAt,
      );
      if (concurrentPolicyExpiry === null) return "unavailable";
      if (
        concurrentPolicyExpiry <= checkedNow(dependencies.now ?? Date.now) ||
        !confirmed.session.entitlements.includes("tf.search")
      ) {
        return "forbidden";
      }
    }
    return activePolicyBinding(
      ticket,
      confirmed,
      introspection,
      checkedNow(dependencies.now ?? Date.now),
    );
  } catch {
    return "unavailable";
  }
}

function rawDataBytes(data: RawData): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return null;
}

function validatedPlayerMessage(
  data: RawData,
  isBinary: boolean,
): string | null {
  if (isBinary) return null;
  const bytes = rawDataBytes(data);
  if (bytes === null || bytes.byteLength > MAX_MESSAGE_BYTES) return null;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parsed = playerSyncMessageSchema.parse(
      JSON.parse(decoder.decode(bytes)) as unknown,
    );
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

export function canBufferWebSocketMessage(
  bufferedBytes: number,
  messageBytes: number,
): boolean {
  return (
    Number.isSafeInteger(bufferedBytes) &&
    bufferedBytes >= 0 &&
    Number.isSafeInteger(messageBytes) &&
    messageBytes >= 0 &&
    bufferedBytes + messageBytes <= MAX_BUFFERED_BYTES
  );
}

function rejectUpgrade(socket: Duplex, status: 401 | 404 | 503): void {
  const reasons = {
    401: "Unauthorized",
    404: "Not Found",
    503: "Service Unavailable",
  } as const;
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(
    `HTTP/1.1 ${status} ${reasons[status]}\r\n` +
      "Connection: close\r\n" +
      "Cache-Control: no-store\r\n" +
      "Content-Length: 0\r\n\r\n",
  );
}

export function attachWebSocketServer(
  server: Server,
  dependencies: WebSocketServerDependencies,
): WebSocketServerHandle {
  const log = dependencies.logger ?? defaultLogger;
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  const rooms = new Map<string, Set<WebSocket>>();
  const contexts = new Map<WebSocket, SocketContext>();
  const pendingSockets = new Set<Duplex>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const deauthorizeSocket = (ws: WebSocket, context: SocketContext): void => {
    if (!context.authorized) return;
    context.authorized = false;
    context.room.delete(ws);
    if (context.room.size === 0) rooms.delete(context.ticket.accountId);
  };

  const cleanupSocket = (ws: WebSocket): void => {
    const context = contexts.get(ws);
    if (context === undefined || context.cleaned) return;
    context.cleaned = true;
    scheduler.clearInterval(context.timer);
    deauthorizeSocket(ws, context);
    contexts.delete(ws);
    ws.off("message", onMessage);
    ws.off("close", onSocketClose);
    ws.off("error", onSocketError);
    log.debug(
      { component: COMPONENT, roomSize: context.room.size },
      "WebSocket client disconnected",
    );
  };

  const onMessage = function (
    this: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): void {
    const context = contexts.get(this);
    if (
      context === undefined ||
      !context.authorized ||
      this.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const message = validatedPlayerMessage(data, isBinary);
    if (message === null) return;
    for (const client of context.room) {
      const recipientContext = contexts.get(client);
      if (
        client !== this &&
        recipientContext?.authorized === true &&
        client.readyState === WebSocket.OPEN
      ) {
        if (
          !canBufferWebSocketMessage(
            client.bufferedAmount,
            Buffer.byteLength(message, "utf8"),
          )
        ) {
          log.warn(
            { component: COMPONENT, category: "slow_consumer" },
            "WebSocket client buffer exceeded",
          );
          client.close(1013, "buffer_unavailable");
          continue;
        }
        client.send(message);
      }
    }
  };

  const onSocketClose = function (this: WebSocket): void {
    cleanupSocket(this);
  };

  const onSocketError = function (this: WebSocket): void {
    log.warn(
      { component: COMPONENT, category: "socket_error" },
      "WebSocket client error",
    );
    cleanupSocket(this);
    this.terminate();
  };

  const validateConnected = async (
    ws: WebSocket,
    context: SocketContext,
  ): Promise<void> => {
    if (
      context.cleaned ||
      !context.authorized ||
      context.validating ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    context.validating = true;
    try {
      const result = await validateBackingPolicy(context.ticket, dependencies);
      if (
        context.cleaned ||
        !context.authorized ||
        ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (result === "forbidden") {
        deauthorizeSocket(ws, context);
        ws.close(4403, "policy_revoked");
      } else if (result === "unavailable") {
        deauthorizeSocket(ws, context);
        ws.close(1013, "policy_unavailable");
      }
    } finally {
      context.validating = false;
    }
  };

  const connectSocket = (ws: WebSocket, ticket: WebSocketTicket): void => {
    const room = rooms.get(ticket.accountId) ?? new Set<WebSocket>();
    if (!rooms.has(ticket.accountId)) rooms.set(ticket.accountId, room);
    room.add(ws);
    const context: SocketContext = {
      ticket,
      room,
      timer: undefined,
      authorized: true,
      validating: false,
      cleaned: false,
    };
    context.timer = scheduler.setInterval(() => {
      void validateConnected(ws, context);
    }, VALIDATION_INTERVAL_MS);
    contexts.set(ws, context);
    ws.on("message", onMessage);
    ws.on("close", onSocketClose);
    ws.on("error", onSocketError);
    log.debug(
      { component: COMPONENT, roomSize: room.size },
      "WebSocket client connected",
    );
  };

  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    pendingSockets.add(socket);
    const target = parseUpgradeTarget(request.url);
    if (target.kind === "not_found") {
      pendingSockets.delete(socket);
      rejectUpgrade(socket, 404);
      return;
    }
    if (target.kind === "invalid") {
      pendingSockets.delete(socket);
      rejectUpgrade(socket, 401);
      return;
    }
    if (!validUpgradeHandshake(request)) {
      pendingSockets.delete(socket);
      rejectUpgrade(socket, 401);
      return;
    }
    let ticket: WebSocketTicket | null;
    try {
      ticket = await dependencies.sessionStore.consumeWebSocketTicket(
        target.ticket,
      );
    } catch {
      pendingSockets.delete(socket);
      rejectUpgrade(socket, 503);
      return;
    }
    if (ticket === null) {
      pendingSockets.delete(socket);
      rejectUpgrade(socket, 401);
      return;
    }
    const validation = await validateBackingPolicy(ticket, dependencies);
    if (validation !== "authorized" || closed) {
      pendingSockets.delete(socket);
      rejectUpgrade(socket, validation === "unavailable" || closed ? 503 : 401);
      return;
    }
    pendingSockets.delete(socket);
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        connectSocket(ws, ticket!);
      });
    } catch {
      rejectUpgrade(socket, 503);
    }
  };

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    void handleUpgrade(request, socket, head).catch(() => {
      pendingSockets.delete(socket);
      rejectUpgrade(socket, 503);
    });
  };

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      closed = true;
      server.off("upgrade", onUpgrade);
      server.off("close", onServerClose);
      for (const socket of pendingSockets) socket.destroy();
      pendingSockets.clear();
      for (const ws of [...contexts.keys()]) {
        cleanupSocket(ws);
        ws.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      log.info({ component: COMPONENT }, "WebSocket server closed");
    })();
    return closePromise;
  };

  const onServerClose = (): void => {
    void close();
  };

  server.on("upgrade", onUpgrade);
  server.once("close", onServerClose);
  log.info({ component: COMPONENT }, "WebSocket server attached");
  return { close };
}
