import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import router from "./routes";
import { logger } from "./lib/logger";
import { adminRequestTelemetry } from "./lib/admin-telemetry";
import { moduleHeartbeatRouter } from "./routes/module-heartbeats";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
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

app.use((req, res, next) => {
  res.once("finish", () => {
    adminRequestTelemetry.record({
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
    });
  });
  next();
});

const PRODUCTION_ORIGINS = [
  "https://web.apollot.ru",
  "https://api.apollot.ru",
  "https://apollot.ru",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (PRODUCTION_ORIGINS.includes(origin)) return callback(null, true);
      if (origin.includes("localhost") || origin.includes("127.0.0.1"))
        return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Client-Session"],
  }),
);

app.use("/api", moduleHeartbeatRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  }),
);

app.use("/api", router);

export default app;
