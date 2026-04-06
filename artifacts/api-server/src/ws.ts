import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { logger } from "./lib/logger.js";

export interface PlayerSyncMessage {
  type: "player_state";
  track: {
    id: string;
    title: string;
    artist: string;
    thumbnailUrl: string | null;
    duration: number;
    source?: string;
  } | null;
  position: number;
  isPlaying: boolean;
}

const rooms = new Map<string, Set<WebSocket>>();

export function attachWebSocketServer(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const baseUrl = `ws://localhost`;
    const url = new URL(req.url ?? "/", baseUrl);

    if (!url.pathname.endsWith("/ws")) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = url.searchParams.get("sessionId")?.trim();
    if (!sessionId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, sessionId);
    });
  });

  wss.on(
    "connection",
    (ws: WebSocket, _req: IncomingMessage, sessionId: string) => {
      if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
      rooms.get(sessionId)!.add(ws);

      logger.debug({ sessionId, roomSize: rooms.get(sessionId)!.size }, "WS client connected");

      ws.on("message", (data) => {
        const room = rooms.get(sessionId);
        if (!room) return;
        const raw = data.toString();
        room.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(raw);
          }
        });
      });

      ws.on("close", () => {
        const room = rooms.get(sessionId);
        if (room) {
          room.delete(ws);
          if (room.size === 0) rooms.delete(sessionId);
        }
        logger.debug({ sessionId }, "WS client disconnected");
      });

      ws.on("error", (err) => {
        logger.warn({ err, sessionId }, "WebSocket error");
      });
    },
  );

  logger.info("WebSocket server attached");
}
