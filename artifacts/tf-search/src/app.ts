import { TextDecoder } from "node:util";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  TF_SEARCH_ARTIST_DISCOVERY_PATH,
  TF_SEARCH_COMMAND_PATH,
  TF_SEARCH_SUGGESTIONS_PATH,
  tfSearchArtistDiscoveryCommandSchema,
  tfSearchArtistDiscoveryResponseSchema,
  tfSearchCommandSchema,
  tfSearchResponseSchema,
  tfSearchSuggestionsCommandSchema,
  tfSearchSuggestionsResponseSchema,
} from "@workspace/tf-search-contract";
import type { InternalRequestAuthenticator } from "./internal-auth.js";
import type { SearchService } from "./search-service.js";

const BODY_LIMIT = 16 * 1024;

export interface CreateTfSearchAppOptions {
  readonly service: SearchService;
  readonly auth: InternalRequestAuthenticator;
  readonly ready: () => boolean;
}

function setResponseHeaders(res: Response): void {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

function requestPath(req: Request): string {
  const queryIndex = req.originalUrl.indexOf("?");
  return queryIndex === -1 ? req.originalUrl : req.originalUrl.slice(0, queryIndex);
}

function isIdentityEncoding(req: Request): boolean {
  const value = req.get("Content-Encoding");
  if (value === undefined) return true;
  const encodings = value.split(",").map((entry) => entry.trim().toLowerCase());
  return encodings.length > 0 && encodings.every((entry) => entry === "identity");
}

function isJsonContentType(req: Request): boolean {
  const value = req.get("Content-Type");
  return value !== undefined && value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function rejectUnsupportedTransport(req: Request, res: Response, next: NextFunction): void {
  if (!isIdentityEncoding(req) || !isJsonContentType(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  delete req.headers["content-encoding"];
  next();
}

function rawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function parseJsonBody(value: Buffer): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    return undefined;
  }
}

function authenticate(
  req: Request,
  auth: InternalRequestAuthenticator,
): boolean {
  try {
    return auth.authenticate({
      method: req.method,
      path: requestPath(req),
      timestamp: req.get("X-Apollo-Internal-Timestamp"),
      nonce: req.get("X-Apollo-Internal-Nonce"),
      signature: req.get("X-Apollo-Internal-Signature"),
      rawBody: rawBody(req),
    });
  } catch {
    return false;
  }
}

function unavailable(res: Response): void {
  res.status(503).json({ error: "search_unavailable" });
}

function isReady(ready: () => boolean): boolean {
  try {
    return ready();
  } catch {
    return false;
  }
}

export function createTfSearchApp(options: CreateTfSearchAppOptions): Express {
  const app = express();
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  app.use((_req, res, next) => {
    setResponseHeaders(res);
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/readyz", (_req, res) => {
    const ready = isReady(options.ready);
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "unavailable",
    });
  });

  const signedRequest = [
    rejectUnsupportedTransport,
    express.raw({ type: () => true, limit: BODY_LIMIT, inflate: false }),
  ] as const;

  app.post(TF_SEARCH_COMMAND_PATH, ...signedRequest, async (req, res) => {
    if (!authenticate(req, options.auth)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!isReady(options.ready)) {
      unavailable(res);
      return;
    }
    const command = tfSearchCommandSchema.safeParse(parseJsonBody(rawBody(req)));
    if (!command.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const response = tfSearchResponseSchema.safeParse(await options.service.search(command.data));
      if (!response.success) {
        unavailable(res);
        return;
      }
      res.status(200).json(response.data);
    } catch {
      unavailable(res);
    }
  });

  app.post(TF_SEARCH_SUGGESTIONS_PATH, ...signedRequest, async (req, res) => {
    if (!authenticate(req, options.auth)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!isReady(options.ready)) {
      unavailable(res);
      return;
    }
    const command = tfSearchSuggestionsCommandSchema.safeParse(parseJsonBody(rawBody(req)));
    if (!command.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const response = tfSearchSuggestionsResponseSchema.safeParse(
        await options.service.suggestions(command.data),
      );
      if (!response.success) {
        unavailable(res);
        return;
      }
      res.status(200).json(response.data);
    } catch {
      unavailable(res);
    }
  });

  app.post(TF_SEARCH_ARTIST_DISCOVERY_PATH, ...signedRequest, async (req, res) => {
    if (!authenticate(req, options.auth)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!isReady(options.ready)) {
      unavailable(res);
      return;
    }
    const command = tfSearchArtistDiscoveryCommandSchema.safeParse(
      parseJsonBody(rawBody(req)),
    );
    if (!command.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const response = tfSearchArtistDiscoveryResponseSchema.safeParse(
        await options.service.discoverArtist(command.data),
      );
      if (!response.success) {
        unavailable(res);
        return;
      }
      res.status(200).json(response.data);
    } catch {
      unavailable(res);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status =
      typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large"
        ? 413
        : 400;
    res.status(status).json({ error: "invalid_request" });
  });

  return app;
}
