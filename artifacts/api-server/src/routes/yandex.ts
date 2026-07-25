import type {
  NormalizedTrack,
  TfIntegrationsErrorResponse,
} from "@workspace/tf-integrations-contract";
import { Router, type IRouter, type Response } from "express";

import {
  TfIntegrationsUnavailableError,
  type TfIntegrationsGateway,
} from "../lib/tf-integrations-client.js";

const MAX_PAGE_SIZE = 50;

export interface YandexRouteDependencies {
  readonly gateway: TfIntegrationsGateway;
}

const unavailableGateway: TfIntegrationsGateway = {
  async execute() {
    throw new TfIntegrationsUnavailableError();
  },
};

function isFailure(
  value: object,
): value is TfIntegrationsErrorResponse {
  return "error" in value;
}

function paginationValue(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function pagination(query: Readonly<Record<string, unknown>>): {
  readonly offset: number;
  readonly limit: number;
} {
  return {
    offset: paginationValue(query["offset"], 0, 1_000_000),
    limit: Math.max(
      1,
      paginationValue(query["limit"], MAX_PAGE_SIZE, MAX_PAGE_SIZE),
    ),
  };
}

function mapTrack(track: NormalizedTrack) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: track.duration * 1_000,
    thumbnailUrl: track.thumbnailUrl,
    trackUrl: track.providerUrl,
  };
}

function sendNotConnected(response: Response): void {
  response.status(401).json({
    error: "not_connected",
    message: "Yandex Music session not found",
  });
}

function sendLibraryFailure(
  response: Response,
  failure: TfIntegrationsErrorResponse,
  message: string,
): void {
  if (failure.error.code === "not_connected") {
    sendNotConnected(response);
    return;
  }
  response.status(502).json({ error: "ym_error", message });
}

export function createYandexRouter(
  overrides: Partial<YandexRouteDependencies> = {},
): IRouter {
  const dependencies: YandexRouteDependencies = {
    gateway: unavailableGateway,
    ...overrides,
  };
  const router = Router();

  router.post("/yandex/token", async (request, response) => {
    const token =
      typeof request.body === "object" &&
      request.body !== null &&
      typeof (request.body as Record<string, unknown>).token === "string"
        ? (request.body as Record<string, string>).token.trim()
        : "";
    if (token.length < 10 || token.length > 8_192) {
      response.status(400).json({
        error: "invalid_token",
        message: "Token is required",
      });
      return;
    }

    try {
      const result = await dependencies.gateway.execute({
        accountId: request.tfPrincipal!.accountId,
        operation: "yandex.token.upsert",
        input: { token },
      });
      if (isFailure(result)) {
        if (result.error.code === "storage_unavailable") {
          response.status(503).json({ error: "yandex_unavailable" });
          return;
        }
        response.status(401).json({
          error: "auth_failed",
          message:
            "Could not authenticate with Yandex Music. Check your token.",
        });
        return;
      }
      response.json({
        ok: true,
        displayName: result.result.account.account.displayName,
        login: result.result.account.account.displayName,
        userId: result.result.account.account.id,
      });
    } catch {
      response.status(503).json({ error: "yandex_unavailable" });
    }
  });

  router.get("/yandex/status", async (request, response) => {
    try {
      const result = await dependencies.gateway.execute({
        accountId: request.tfPrincipal!.accountId,
        operation: "yandex.status",
        input: {},
      });
      if (isFailure(result)) {
        response.status(503).json({ error: "yandex_unavailable" });
        return;
      }
      if (!result.result.account.connected) {
        response.json({ connected: false });
        return;
      }
      response.json({
        connected: true,
        displayName: result.result.account.account.displayName,
        login: result.result.account.account.displayName,
        userId: result.result.account.account.id,
      });
    } catch (error) {
      if (error instanceof TfIntegrationsUnavailableError) {
        response.status(503).json({ error: "yandex_unavailable" });
        return;
      }
      throw error;
    }
  });

  router.post("/yandex/logout", async (request, response) => {
    try {
      const result = await dependencies.gateway.execute({
        accountId: request.tfPrincipal!.accountId,
        operation: "yandex.disconnect",
        input: {},
      });
      if (isFailure(result)) {
        response.status(503).json({ error: "yandex_unavailable" });
        return;
      }
      response.json({ ok: true });
    } catch {
      response.status(503).json({ error: "yandex_unavailable" });
    }
  });

  router.get("/yandex/liked", async (request, response) => {
    const page = pagination(request.query);
    try {
      const result = await dependencies.gateway.execute({
        accountId: request.tfPrincipal!.accountId,
        operation: "yandex.liked.list",
        input: page,
      });
      if (isFailure(result)) {
        sendLibraryFailure(
          response,
          result,
          "Failed to fetch liked tracks",
        );
        return;
      }
      response.json({
        tracks: result.result.tracks.map(mapTrack),
        total: result.result.total,
        offset: page.offset,
        limit: page.limit,
      });
    } catch {
      response.status(502).json({
        error: "ym_error",
        message: "Failed to fetch liked tracks",
      });
    }
  });

  router.get("/yandex/playlists", async (request, response) => {
    try {
      const result = await dependencies.gateway.execute({
        accountId: request.tfPrincipal!.accountId,
        operation: "yandex.playlists.list",
        input: {},
      });
      if (isFailure(result)) {
        sendLibraryFailure(response, result, "Failed to fetch playlists");
        return;
      }
      response.json(result.result);
    } catch {
      response.status(502).json({
        error: "ym_error",
        message: "Failed to fetch playlists",
      });
    }
  });

  router.get(
    "/yandex/playlists/:uid/:kind/tracks",
    async (request, response) => {
      const page = pagination(request.query);
      const uid = Number(request.params.uid);
      const kind = Number(request.params.kind);
      try {
        const result = await dependencies.gateway.execute({
          accountId: request.tfPrincipal!.accountId,
          operation: "yandex.playlist-tracks.list",
          input: { uid, kind, ...page },
        });
        if (isFailure(result)) {
          sendLibraryFailure(
            response,
            result,
            "Failed to fetch playlist tracks",
          );
          return;
        }
        response.json({
          tracks: result.result.tracks.map(mapTrack),
          total: result.result.total,
          offset: page.offset,
          limit: page.limit,
        });
      } catch {
        response.status(502).json({
          error: "ym_error",
          message: "Failed to fetch playlist tracks",
        });
      }
    },
  );

  return router;
}

export default createYandexRouter();
