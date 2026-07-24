import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import session from "express-session";
import type { Logger } from "pino";
import pinoHttp from "pino-http";

import { adminRequestTelemetry } from "./lib/admin-telemetry.js";
import { logger } from "./lib/logger.js";
import { createApiRouter, type ApiRouterOptions } from "./routes/index.js";
import { moduleHeartbeatRouter } from "./routes/module-heartbeats.js";

const PRODUCTION_ORIGINS = [
  "https://web.apollot.ru",
  "https://tf.apollot.ru",
  "https://api.apollot.ru",
  "https://apollot.ru",
];

function isExactLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export interface ApiAppOptions extends ApiRouterOptions {
  readonly requestLogger?: Logger;
}

export function createApiApp(options: ApiAppOptions = {}): Express {
  const app: Express = express();
  const requestLogger = options.requestLogger ?? logger;
  const allowedOrigins = new Set(PRODUCTION_ORIGINS);
  if (options.auth !== undefined) {
    allowedOrigins.add(options.auth.webOrigin);
  }

  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      logger: requestLogger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );

  app.use((request, response, next) => {
    response.once("finish", () => {
      adminRequestTelemetry.record({
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
      });
    });
    next();
  });

  app.use("/api", moduleHeartbeatRouter);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        if (isExactLoopbackOrigin(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
    }),
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  const sessionSecret =
    process.env["SESSION_SECRET"] ?? "dev-secret-change-in-production";
  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env["NODE_ENV"] === "production",
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1_000,
        sameSite: "lax",
      },
    }),
  );

  app.use("/api", createApiRouter({ auth: options.auth }));
  return app;
}
